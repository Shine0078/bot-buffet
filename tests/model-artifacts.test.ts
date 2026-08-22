import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  FREE_SPACE_HEADROOM_BYTES,
  formatBytes,
  hashFile,
  isAllowedSource,
  isConfined,
  isSafeArtifactName,
  planModelImport,
  verifyArtifact,
  volumeSpace,
} from '../src/modelArtifacts.js';

const STORE_ROOT = resolve('/srv/bot-buffet/models');
const ROOMY = { totalBytes: 1024 ** 4, freeBytes: 1024 ** 4 };
const DIGEST = 'a'.repeat(64);

const request = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'llama-3-8b-q4.gguf',
  sha256: DIGEST,
  sizeBytes: 4 * 1024 ** 3,
  ...overrides,
});

describe('model artifact import planning', () => {
  it('accepts a well-formed import and reports the space left afterwards', () => {
    const result = planModelImport(request(), STORE_ROOT, ROOMY);
    expect(result.ok).toBe(true);
    expect(result.plan?.sha256).toBe(DIGEST);
    expect(result.plan?.destination).toBe(join(STORE_ROOT, 'llama-3-8b-q4.gguf'));
    expect(result.plan?.freeBytesAfter).toBe(ROOMY.freeBytes - 4 * 1024 ** 3);
  });

  it('refuses an artifact with no digest rather than importing it unverified', () => {
    expect(planModelImport(request({ sha256: null }), STORE_ROOT, ROOMY).refusals).toContain(
      'model_artifact_digest_required',
    );
    expect(planModelImport(request({ sha256: '   ' }), STORE_ROOT, ROOMY).refusals).toContain(
      'model_artifact_digest_required',
    );
  });

  it('refuses a digest that is not 64 hex characters', () => {
    for (const bad of ['abc', DIGEST.slice(0, 63), `${DIGEST}f`, 'z'.repeat(64)]) {
      expect(planModelImport(request({ sha256: bad }), STORE_ROOT, ROOMY).refusals).toContain(
        'model_artifact_digest_malformed',
      );
    }
  });

  it('normalises an uppercase digest instead of rejecting it', () => {
    const result = planModelImport(request({ sha256: DIGEST.toUpperCase() }), STORE_ROOT, ROOMY);
    expect(result.ok).toBe(true);
    expect(result.plan?.sha256).toBe(DIGEST);
  });

  it('requires a positive integer size so the space check cannot be skipped', () => {
    for (const bad of [null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planModelImport(request({ sizeBytes: bad }), STORE_ROOT, ROOMY).refusals).toContain(
        'model_artifact_size_required',
      );
    }
  });

  it('refuses an artifact above the ceiling', () => {
    const result = planModelImport(
      request({ sizeBytes: DEFAULT_MAX_ARTIFACT_BYTES + 1 }),
      STORE_ROOT,
      { totalBytes: Number.MAX_SAFE_INTEGER, freeBytes: Number.MAX_SAFE_INTEGER },
    );
    expect(result.refusals).toContain('model_artifact_too_large');
  });

  it('refuses before download when the volume lacks room plus headroom', () => {
    const tight = { totalBytes: 10 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 };
    const result = planModelImport(request({ sizeBytes: 4 * 1024 ** 3 }), STORE_ROOT, tight);
    expect(result.ok).toBe(false);
    expect(result.refusals).toContain('model_artifact_insufficient_space');
  });

  it('keeps headroom so an import cannot fill the volume the state lives on', () => {
    const exact = { totalBytes: 10 * 1024 ** 3, freeBytes: 1024 ** 3 + FREE_SPACE_HEADROOM_BYTES };
    expect(planModelImport(request({ sizeBytes: 1024 ** 3 }), STORE_ROOT, exact).ok).toBe(true);
    expect(planModelImport(request({ sizeBytes: 1024 ** 3 + 1 }), STORE_ROOT, exact).ok).toBe(
      false,
    );
  });

  it('reports every refusal at once rather than only the first', () => {
    const result = planModelImport(
      { fileName: '../escape.gguf', sha256: null, sizeBytes: null, sourceUrl: 'http://insecure' },
      STORE_ROOT,
      ROOMY,
    );
    expect(result.refusals).toEqual(
      expect.arrayContaining([
        'model_artifact_name_invalid',
        'model_artifact_digest_required',
        'model_artifact_size_required',
        'model_artifact_source_invalid',
      ]),
    );
  });

  it('records quantization and license metadata, bounded', () => {
    const result = planModelImport(
      request({ quantization: 'Q4_K_M', license: 'apache-2.0' }),
      STORE_ROOT,
      ROOMY,
    );
    expect(result.plan?.quantization).toBe('Q4_K_M');
    expect(result.plan?.license).toBe('apache-2.0');
    const long = planModelImport(request({ license: 'x'.repeat(200) }), STORE_ROOT, ROOMY);
    expect(long.plan?.license).toHaveLength(64);
  });
});

describe('model artifact name and path confinement', () => {
  it('rejects traversal, separators, null bytes, and absolute paths', () => {
    for (const bad of [
      '../escape.gguf',
      '..',
      '.',
      'sub/dir.gguf',
      'sub\\dir.gguf',
      'weights\0.gguf',
      '/etc/passwd',
      'C:\\Windows\\system32',
      '',
      'x'.repeat(256),
    ]) {
      expect(isSafeArtifactName(bad), `${JSON.stringify(bad)} should be rejected`).toBe(false);
    }
  });

  it('rejects Windows reserved device names with or without an extension', () => {
    for (const bad of ['con', 'CON.gguf', 'nul', 'COM1', 'lpt9.bin', 'aux.txt']) {
      expect(isSafeArtifactName(bad), `${bad} should be rejected`).toBe(false);
    }
  });

  it('accepts ordinary weight file names', () => {
    for (const good of [
      'llama-3-8b-q4.gguf',
      'model.safetensors',
      'a.bin',
      'mistral_7b.Q5_K_M.gguf',
    ]) {
      expect(isSafeArtifactName(good), `${good} should be accepted`).toBe(true);
    }
  });

  it('confines the destination beneath the store root', () => {
    expect(isConfined(STORE_ROOT, join(STORE_ROOT, 'a.gguf'))).toBe(true);
    expect(isConfined(STORE_ROOT, resolve(STORE_ROOT, '..', 'a.gguf'))).toBe(false);
    // The root itself is not a valid destination.
    expect(isConfined(STORE_ROOT, STORE_ROOT)).toBe(false);
  });
});

describe('model artifact source policy', () => {
  it('allows https and explicit local file imports only', () => {
    expect(isAllowedSource('https://example.invalid/model.gguf')).toBe(true);
    expect(isAllowedSource('file:///models/model.gguf')).toBe(true);
  });

  it('refuses plaintext and other transports', () => {
    for (const bad of [
      'http://example.invalid/model.gguf',
      'ftp://example.invalid/model.gguf',
      'data:text/plain,hello',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isAllowedSource(bad), `${bad} should be refused`).toBe(false);
    }
  });
});

describe('model artifact verification', () => {
  let dir = '';
  let file = '';
  const content = 'weights-not-really';
  const digest = createHash('sha256').update(content).digest('hex');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bot-buffet-models-'));
    file = join(dir, 'model.gguf');
    await writeFile(file, content);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hashes a file by streaming it', async () => {
    expect(await hashFile(file)).toBe(digest);
  });

  it('verifies a matching digest and size', async () => {
    const result = await verifyArtifact(file, digest, Buffer.byteLength(content));
    expect(result.verified).toBe(true);
    expect(result.actualSha256).toBe(digest);
    expect(result.actualBytes).toBe(Buffer.byteLength(content));
  });

  it('accepts an uppercase expected digest', async () => {
    expect((await verifyArtifact(file, digest.toUpperCase())).verified).toBe(true);
  });

  it('fails a mismatched digest and names the reason', async () => {
    const result = await verifyArtifact(file, 'b'.repeat(64));
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('model_artifact_digest_mismatch');
    // The real digest is still reported so the operator can compare.
    expect(result.actualSha256).toBe(digest);
  });

  it('fails a size mismatch before comparing digests', async () => {
    const result = await verifyArtifact(file, digest, Buffer.byteLength(content) + 1);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('model_artifact_size_mismatch');
  });

  it('fails a malformed expected digest rather than throwing', async () => {
    const result = await verifyArtifact(file, 'not-a-digest');
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('model_artifact_digest_mismatch');
  });

  it('reads real free space for the pre-download check', async () => {
    const space = await volumeSpace(dir);
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.freeBytes).toBeGreaterThanOrEqual(0);
    expect(space.freeBytes).toBeLessThanOrEqual(space.totalBytes);
  });
});

describe('size formatting for the pre-download confirmation', () => {
  it('scales into binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(4 * 1024 ** 3)).toBe('4.0 GiB');
  });

  it('does not invent a number it does not have', () => {
    expect(formatBytes(Number.NaN)).toBe('unknown');
    expect(formatBytes(-1)).toBe('unknown');
  });
});
