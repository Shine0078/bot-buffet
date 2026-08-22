import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { AuditEvent, Model } from '../src/types.js';

/**
 * End-to-end evidence that the harness, not the caller, decides whether a model
 * artifact is acceptable. The route is exercised against real bytes on disk.
 */

const servers: Array<ReturnType<typeof createApi>> = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-import-'));
  const modelStoreRoot = join(dir, 'models');
  await mkdir(modelStoreRoot, { recursive: true });
  const store = createStore(dir);
  const server = createApi({
    store,
    orchestrator: new EventEmitter() as unknown as Orchestrator,
    uiRoot: dir,
    vault: new CredentialVault(join(dir, 'credentials.enc.json'), 'test'),
    modelStoreRoot,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_missing');
  return { base: `http://127.0.0.1:${address.port}`, modelStoreRoot, store };
}

/** Register a local model through the public API and return its id. */
async function registerModel(base: string): Promise<string> {
  const response = await fetch(`${base}/api/v1/local-models/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerKind: 'ollama',
      endpoint: 'http://127.0.0.1:11434/v1',
      modelName: 'llama-3-8b',
    }),
  });
  expect([200, 201]).toContain(response.status);
  const body = (await response.json()) as { model: { id: string } };
  return body.model.id;
}

const importArtifact = (base: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/v1/local-models/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('verified local model artifact import', () => {
  it('imports an artifact whose digest matches the bytes on disk', async () => {
    const { base, modelStoreRoot, store } = await start();
    const modelId = await registerModel(base);
    const content = 'pretend-weights';
    const sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(join(modelStoreRoot, 'llama.gguf'), content);

    const response = await importArtifact(base, {
      modelId,
      fileName: 'llama.gguf',
      sha256,
      sizeBytes: Buffer.byteLength(content),
      quantization: 'Q4_K_M',
      license: 'llama3',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      verified: boolean;
      sha256: string;
      sizeHuman: string;
      model: { artifactSha256: string; quantization: string; license: string; sizeBytes: number };
    };
    expect(body.verified).toBe(true);
    expect(body.sha256).toBe(sha256);
    expect(body.model.artifactSha256).toBe(sha256);
    expect(body.model.quantization).toBe('Q4_K_M');
    expect(body.model.license).toBe('llama3');
    expect(body.model.sizeBytes).toBe(Buffer.byteLength(content));
    expect(body.sizeHuman).toMatch(/B$/);

    const audit = await store.list<AuditEvent>((x) => x.kind === 'audit-event');
    const event = audit.find((item) => item.action === 'model.artifact_import');
    expect(event?.decision).toBe('allowed');
    // The audit chain must still verify after the import.
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });

  it('refuses an artifact whose bytes do not match the declared digest', async () => {
    const { base, modelStoreRoot, store } = await start();
    const modelId = await registerModel(base);
    await writeFile(join(modelStoreRoot, 'tampered.gguf'), 'substituted-weights');

    const response = await importArtifact(base, {
      modelId,
      fileName: 'tampered.gguf',
      sha256: createHash('sha256').update('the-weights-i-asked-for').digest('hex'),
      sizeBytes: Buffer.byteLength('substituted-weights'),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; actualSha256: string };
    expect(body.code).toBe('model_artifact_digest_mismatch');

    // The rejection is auditable at high risk, and the model must not record it.
    const audit = await store.list<AuditEvent>((x) => x.kind === 'audit-event');
    const event = audit.find((item) => item.action === 'model.artifact_import');
    expect(event?.decision).toBe('denied');
    expect(event?.risk).toBe('high');
    const model = await store.get<Model>(modelId);
    expect(model?.artifactSha256).toBeUndefined();
  });

  it('refuses an import that supplies no digest at all', async () => {
    const { base, modelStoreRoot } = await start();
    const modelId = await registerModel(base);
    await writeFile(join(modelStoreRoot, 'unverified.gguf'), 'weights');

    const response = await importArtifact(base, {
      modelId,
      fileName: 'unverified.gguf',
      sizeBytes: 7,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; refusals: string[] };
    expect(body.refusals).toContain('model_artifact_digest_required');
  });

  it('refuses a file name that tries to escape the model store', async () => {
    const { base } = await start();
    const modelId = await registerModel(base);
    for (const fileName of ['../outside.gguf', 'nested/inside.gguf', '/etc/passwd']) {
      const response = await importArtifact(base, {
        modelId,
        fileName,
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
      });
      expect(response.status, `${fileName} should be refused`).toBe(400);
      const body = (await response.json()) as { refusals: string[] };
      expect(body.refusals).toContain('model_artifact_name_invalid');
    }
  });

  it('refuses a plaintext http source before any transfer is attempted', async () => {
    const { base } = await start();
    const modelId = await registerModel(base);
    const response = await importArtifact(base, {
      modelId,
      fileName: 'model.gguf',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      sourceUrl: 'http://example.invalid/model.gguf',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { refusals: string[] };
    expect(body.refusals).toContain('model_artifact_source_invalid');
  });

  it('reports a missing artifact instead of registering an unverified model', async () => {
    const { base } = await start();
    const modelId = await registerModel(base);
    const response = await importArtifact(base, {
      modelId,
      fileName: 'absent.gguf',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'model_artifact_unreadable' });
  });

  it('previews size, free space, and fit before any download starts', async () => {
    const { base, modelStoreRoot } = await start();
    const modelId = await registerModel(base);

    const response = await fetch(`${base}/api/v1/local-models/import/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId,
        fileName: 'llama.gguf',
        sha256: 'a'.repeat(64),
        sizeBytes: 4 * 1024 ** 3,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      sizeHuman: string;
      freeBytes: number;
      freeBytesHuman: string;
      host: { gpu: { detection: string }; detection: { gpu: boolean; memory: boolean } };
      fit: { verdict: string };
    };
    expect(body.ok).toBe(true);
    expect(body.sizeHuman).toBe('4.0 GiB');
    expect(body.freeBytes).toBeGreaterThan(0);
    expect(body.freeBytesHuman).toMatch(/(B|KiB|MiB|GiB|TiB)$/);
    // GPU must be reported as undetected rather than fabricated.
    expect(body.host.gpu.detection).toBe('unknown');
    expect(body.host.detection.gpu).toBe(false);
    expect(body.host.detection.memory).toBe(true);
    expect(['fits', 'tight', 'insufficient', 'unknown']).toContain(body.fit.verdict);

    // A dry run must not have written anything.
    const { readdir } = await import('node:fs/promises');
    await expect(readdir(modelStoreRoot)).resolves.toEqual([]);
  });

  it('reports the same refusals in a preview as the import would enforce', async () => {
    const { base } = await start();
    const modelId = await registerModel(base);
    const response = await fetch(`${base}/api/v1/local-models/import/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId, fileName: '../escape.gguf' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; refusals: string[] };
    expect(body.ok).toBe(false);
    expect(body.refusals).toEqual(
      expect.arrayContaining([
        'model_artifact_name_invalid',
        'model_artifact_digest_required',
        'model_artifact_size_required',
      ]),
    );
  });

  it('rejects an import against an unknown model', async () => {
    const { base } = await start();
    const response = await importArtifact(base, {
      modelId: 'model_does_not_exist',
      fileName: 'model.gguf',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
