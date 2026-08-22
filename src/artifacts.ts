import { createHash } from 'node:crypto';
import { Artifact } from './types.js';

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

/** Patterns that must never leave the workspace inside an exported artifact. */
const SENSITIVE_CONTENT =
  /(sk-[A-Za-z0-9_-]{12,}|AIza[\w-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;

export interface ArtifactScan {
  status: Artifact['scanStatus'];
  reasons: string[];
}

export const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * Scan artifact content before it is registered or exported. Oversized payloads and embedded
 * credential material block the artifact instead of silently shipping it.
 */
export function scanArtifact(content: string, declaredSize?: number): ArtifactScan {
  const reasons: string[] = [];
  const size = declaredSize ?? Buffer.byteLength(content, 'utf8');
  if (size > MAX_ARTIFACT_BYTES) reasons.push('artifact_too_large');
  if (SENSITIVE_CONTENT.test(content)) reasons.push('artifact_contains_credential');
  if (content.includes('\0')) reasons.push('artifact_contains_null_byte');
  return { status: reasons.length ? 'blocked' : 'clean', reasons };
}

export interface CheckpointManifest {
  projectId: string;
  generatedAt: string;
  artifacts: Array<{ id: string; name: string; sha256: string; size: number; status: string }>;
  manifestSha256: string;
}

/** Build a tamper-evident manifest over a set of artifacts for export or checkpointing. */
export function checkpointManifest(
  projectId: string,
  artifacts: Artifact[],
  generatedAt: string,
): CheckpointManifest {
  const entries = artifacts
    .map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      sha256: artifact.sha256,
      size: artifact.size,
      status: artifact.scanStatus,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    projectId,
    generatedAt,
    artifacts: entries,
    manifestSha256: sha256(JSON.stringify({ projectId, artifacts: entries })),
  };
}
