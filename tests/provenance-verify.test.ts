import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_SCHEMA,
  parseManifest,
  renderChecksums,
  verifyManifest,
} from '../scripts/provenance-verify.mjs';

/**
 * `npm run provenance` wrote a manifest of every artifact and its SHA-256, and
 * nothing ever checked it. A manifest that is generated but never verified is
 * the same class of defect as a gate that never runs: it looks like evidence
 * and proves nothing, because no failure mode produces a visible symptom.
 *
 * These tests are about the failure modes, since the passing case is the one
 * that would be noticed anyway.
 */

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const manifestFor = (artifacts: Array<{ path: string; sha256: string }>) => ({
  schema: MANIFEST_SCHEMA,
  generatedAt: '2026-08-23T00:00:00.000Z',
  sourceRevision: 'abc123',
  artifacts: artifacts.map((artifact) => ({ ...artifact, bytes: 1 })),
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'bot-buffet-prov-'));
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('manifest parsing', () => {
  it('accepts a well-formed manifest', () => {
    const parsed = parseManifest(
      JSON.stringify(manifestFor([{ path: 'dist/a.js', sha256: sha('a') }])),
    );
    expect(parsed.artifacts).toHaveLength(1);
  });

  it('refuses unparsable input rather than treating it as empty', () => {
    for (const bad of ['not json', '[]', 'null', '"a string"', '42']) {
      expect(() => parseManifest(bad), bad).toThrow(/unparsable|schema_unsupported/);
    }
  });

  it('refuses a manifest from a different schema version', () => {
    // A future format may mean something different by the same field names.
    const foreign = { ...manifestFor([{ path: 'a', sha256: sha('a') }]), schema: 'other.v9' };
    expect(() => parseManifest(JSON.stringify(foreign))).toThrow(/schema_unsupported/);
  });

  it('refuses an empty manifest, which would verify vacuously', () => {
    const empty = { ...manifestFor([]), artifacts: [] };
    expect(() => parseManifest(JSON.stringify(empty))).toThrow(/empty/);
  });

  it('refuses an entry whose digest is not a sha256', () => {
    for (const sha256 of ['', 'abc', 'X'.repeat(64), sha('a').toUpperCase()]) {
      const bad = manifestFor([{ path: 'dist/a.js', sha256 }]);
      expect(() => parseManifest(JSON.stringify(bad)), sha256).toThrow(/entry_invalid/);
    }
  });
});

describe('verification outcomes', () => {
  it('passes when every artifact matches', async () => {
    const root = await fixture({ 'dist/a.js': 'alpha' });
    const result = await verifyManifest(
      manifestFor([{ path: 'dist/a.js', sha256: sha('alpha') }]),
      {
        root,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  it('reports a changed artifact with both digests', async () => {
    const root = await fixture({ 'dist/a.js': 'tampered' });
    const result = await verifyManifest(
      manifestFor([{ path: 'dist/a.js', sha256: sha('alpha') }]),
      {
        root,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatched).toHaveLength(1);
    expect(result.mismatched[0]).toMatchObject({
      path: 'dist/a.js',
      expected: sha('alpha'),
      actual: sha('tampered'),
    });
  });

  it('reports an artifact that is absent rather than skipping it', async () => {
    const root = await fixture({});
    const result = await verifyManifest(manifestFor([{ path: 'dist/gone.js', sha256: sha('x') }]), {
      root,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['dist/gone.js']);
  });

  it('fails on an artifact the manifest does not name', async () => {
    // A stale manifest cannot vouch for the whole build, so an extra file is a
    // failure rather than a curiosity.
    const root = await fixture({ 'dist/a.js': 'alpha', 'dist/extra.js': 'surprise' });
    const result = await verifyManifest(
      manifestFor([{ path: 'dist/a.js', sha256: sha('alpha') }]),
      {
        root,
        listDist: async () => ['dist/a.js', 'dist/extra.js'],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(['dist/extra.js']);
  });

  it('separates the three failure modes, because they mean different things', async () => {
    const root = await fixture({ 'dist/changed.js': 'now different' });
    const result = await verifyManifest(
      manifestFor([
        { path: 'dist/changed.js', sha256: sha('original') },
        { path: 'dist/absent.js', sha256: sha('y') },
      ]),
      { root, listDist: async () => ['dist/changed.js', 'dist/unexpected.js'] },
    );
    expect(result.missing).toEqual(['dist/absent.js']);
    expect(result.mismatched.map((entry) => entry.path)).toEqual(['dist/changed.js']);
    expect(result.unlisted).toEqual(['dist/unexpected.js']);
  });
});

describe('sha256sum-compatible rendering', () => {
  it('emits the two-space format the standard tools expect', () => {
    const rendered = renderChecksums(
      manifestFor([
        { path: 'dist/a.js', sha256: sha('alpha') },
        { path: 'dist/b.js', sha256: sha('beta') },
      ]),
    );
    // `<64 hex><two spaces><path>` is what `sha256sum -c` parses.
    for (const line of rendered.trimEnd().split('\n')) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}\S/);
    }
  });

  it('ends with a newline so the file is well formed', () => {
    expect(renderChecksums(manifestFor([{ path: 'dist/a.js', sha256: sha('a') }]))).toMatch(/\n$/);
  });

  it('lists every artifact exactly once', () => {
    const manifest = manifestFor([
      { path: 'dist/a.js', sha256: sha('a') },
      { path: 'dist/b.js', sha256: sha('b') },
      { path: 'package.json', sha256: sha('c') },
    ]);
    expect(renderChecksums(manifest).trimEnd().split('\n')).toHaveLength(3);
  });
});
