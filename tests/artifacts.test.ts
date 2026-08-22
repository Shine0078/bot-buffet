import { describe, expect, it } from 'vitest';
import { MAX_ARTIFACT_BYTES, checkpointManifest, scanArtifact, sha256 } from '../src/artifacts.js';
import { Artifact, entity } from '../src/types.js';

const artifact = (name: string, content: string): Artifact =>
  entity({
    kind: 'artifact',
    ownerId: 'u',
    scope: 'p1',
    projectId: 'p1',
    name,
    path: `artifacts/${name}`,
    mimeType: 'text/plain',
    size: Buffer.byteLength(content, 'utf8'),
    sha256: sha256(content),
    scanStatus: 'clean',
  }) as Artifact;

describe('artifact registry', () => {
  it('marks clean content clean and hashes deterministically', () => {
    const scan = scanArtifact('a normal report body');
    expect(scan).toEqual({ status: 'clean', reasons: [] });
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });

  it('blocks artifacts containing credential material', () => {
    const key = ['sk', 'a1b2c3d4e5f6g7h8'].join('-');
    const scan = scanArtifact(`report body ${key}`);
    expect(scan.status).toBe('blocked');
    expect(scan.reasons).toContain('artifact_contains_credential');
    expect(scanArtifact('-----BEGIN PRIVATE KEY-----').status).toBe('blocked');
  });

  it('blocks oversized artifacts', () => {
    const scan = scanArtifact('small', MAX_ARTIFACT_BYTES + 1);
    expect(scan.reasons).toContain('artifact_too_large');
  });

  it('builds a stable manifest hash regardless of input order', () => {
    const a = artifact('one.md', 'one');
    const b = artifact('two.md', 'two');
    const first = checkpointManifest('p1', [a, b], '2026-08-21T00:00:00.000Z');
    const second = checkpointManifest('p1', [b, a], '2026-08-21T00:00:00.000Z');
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(first.artifacts).toHaveLength(2);
    const tampered = checkpointManifest(
      'p1',
      [{ ...a, sha256: 'tampered' }, b],
      '2026-08-21T00:00:00.000Z',
    );
    expect(tampered.manifestSha256).not.toBe(first.manifestSha256);
  });
});
