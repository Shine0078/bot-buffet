import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Checksum-verified local model artifact import.
 *
 * A model weight file is executable input to an inference runtime, so it is
 * treated exactly like any other untrusted download: the harness decides
 * whether it is acceptable, and the decision is fail-closed at every step.
 *
 *   - No digest means no import. An unverifiable artifact is refused rather
 *     than imported with a warning, because a warning nobody reads is
 *     indistinguishable from no check at all.
 *   - The digest is compared in constant time against a streamed hash, so a
 *     multi-gigabyte file never has to fit in memory.
 *   - Free space is checked against the declared size plus headroom *before*
 *     any download starts, so a half-written weight file cannot fill the
 *     volume the durable state lives on.
 *   - The destination is confined under the model store root, so a crafted
 *     name cannot traverse out of it.
 *
 * The planning half is pure, so every refusal branch is unit-testable without
 * touching a filesystem or a network.
 */

/** A SHA-256 digest as 64 lowercase hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Refuse anything larger than this unless the caller raises the ceiling
 * explicitly. Large local weights are legitimate, but an unbounded default
 * turns a typo into a filled disk.
 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 200 * 1024 * 1024 * 1024;

/**
 * Keep this much of the volume free after the import completes. Writing state
 * atomically requires room for a temporary copy, so an import that lands on
 * exactly zero free bytes would break the control plane rather than just
 * itself.
 */
export const FREE_SPACE_HEADROOM_BYTES = 512 * 1024 * 1024;

export type ImportRefusal =
  | 'model_artifact_digest_required'
  | 'model_artifact_digest_malformed'
  | 'model_artifact_size_required'
  | 'model_artifact_too_large'
  | 'model_artifact_insufficient_space'
  | 'model_artifact_name_invalid'
  | 'model_artifact_path_escape'
  | 'model_artifact_source_invalid';

export interface ModelImportRequest {
  /** File name to store the artifact under, relative to the store root. */
  fileName: string;
  /** Expected SHA-256 as 64 hex characters. Required: there is no bypass. */
  sha256?: string | null;
  /** Declared size in bytes, used for the space check before any transfer. */
  sizeBytes?: number | null;
  /** `file:` for a local import, or an https URL for a download. */
  sourceUrl?: string | null;
  /** Quantization label recorded as metadata (for example `Q4_K_M`). */
  quantization?: string | null;
  /** License identifier recorded as metadata (for example `apache-2.0`). */
  license?: string | null;
}

export interface ModelImportPlan {
  ok: boolean;
  refusals: ImportRefusal[];
  /** Populated only when `ok` is true. */
  plan?: {
    fileName: string;
    destination: string;
    sha256: string;
    sizeBytes: number;
    sourceUrl: string | null;
    quantization: string | null;
    license: string | null;
    /** Space that will remain free after the write, for the pre-download UI. */
    freeBytesAfter: number;
  };
}

export interface VolumeSpace {
  totalBytes: number;
  freeBytes: number;
}

/**
 * Reject anything that is not a plain file name. Directory separators, parent
 * segments, null bytes, and absolute paths are all refused before the name is
 * ever joined to the store root, rather than relying on the join to be safe.
 */
export function isSafeArtifactName(fileName: string): boolean {
  if (!fileName || fileName.length > 255) return false;
  if (fileName.includes('\0')) return false;
  if (fileName.includes('/') || fileName.includes('\\')) return false;
  if (fileName === '.' || fileName === '..') return false;
  if (isAbsolute(fileName)) return false;
  // Windows reserves these device names regardless of extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(fileName)) return false;
  return true;
}

/** Confirm a resolved destination really sits under the store root. */
export function isConfined(storeRoot: string, destination: string): boolean {
  const rootResolved = resolve(storeRoot);
  const destResolved = resolve(destination);
  const rel = relative(rootResolved, destResolved);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Only `https:` downloads and explicit local `file:` imports are allowed. Plain
 * `http:` is refused because an unauthenticated transport gives an attacker the
 * chance to serve different bytes than the digest was published for — the
 * digest still catches it, but a refused download beats a wasted one.
 */
export function isAllowedSource(sourceUrl: string): boolean {
  try {
    const parsed = new URL(sourceUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * The pure decision. Returns every reason an import is refused rather than the
 * first, so the operator can fix the request in one pass instead of discovering
 * the problems one at a time.
 */
export function planModelImport(
  request: ModelImportRequest,
  storeRoot: string,
  space: VolumeSpace,
  maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES,
): ModelImportPlan {
  const refusals: ImportRefusal[] = [];

  const fileName = String(request.fileName ?? '').trim();
  if (!isSafeArtifactName(fileName)) refusals.push('model_artifact_name_invalid');

  const digest = String(request.sha256 ?? '')
    .trim()
    .toLowerCase();
  if (!digest) refusals.push('model_artifact_digest_required');
  else if (!SHA256_HEX.test(digest)) refusals.push('model_artifact_digest_malformed');

  const sizeBytes = Number(request.sizeBytes ?? Number.NaN);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isInteger(sizeBytes)) {
    refusals.push('model_artifact_size_required');
  } else if (sizeBytes > maxBytes) {
    refusals.push('model_artifact_too_large');
  } else if (sizeBytes + FREE_SPACE_HEADROOM_BYTES > space.freeBytes) {
    // Checked before any transfer begins so a doomed download never starts.
    refusals.push('model_artifact_insufficient_space');
  }

  const sourceUrl = request.sourceUrl ? String(request.sourceUrl).trim() : null;
  if (sourceUrl && !isAllowedSource(sourceUrl)) refusals.push('model_artifact_source_invalid');

  const destination = refusals.includes('model_artifact_name_invalid')
    ? ''
    : resolve(storeRoot, fileName);
  if (destination && !isConfined(storeRoot, destination))
    refusals.push('model_artifact_path_escape');

  if (refusals.length) return { ok: false, refusals };

  return {
    ok: true,
    refusals: [],
    plan: {
      fileName,
      destination,
      sha256: digest,
      sizeBytes,
      sourceUrl,
      quantization: request.quantization ? String(request.quantization).slice(0, 64) : null,
      license: request.license ? String(request.license).slice(0, 64) : null,
      freeBytesAfter: space.freeBytes - sizeBytes,
    },
  };
}

/** Free and total bytes on the volume holding `path`. */
export async function volumeSpace(path: string): Promise<VolumeSpace> {
  const stats = await statfs(path);
  // bavail is what an unprivileged process may actually use; bfree includes
  // blocks reserved for root and would overstate the space available to us.
  return {
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
  };
}

/**
 * Stream a file through SHA-256. Streaming matters here: model weights are
 * routinely larger than available memory, and a `readFile` would either fail
 * outright or push the process into swap.
 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface VerificationResult {
  verified: boolean;
  actualSha256: string;
  actualBytes: number;
  /** Set when verification failed, for the audit record. */
  reason?: 'model_artifact_digest_mismatch' | 'model_artifact_size_mismatch';
}

/**
 * Verify a file already on disk against the expected digest and size.
 *
 * The comparison is constant-time. A digest check is not a secret comparison in
 * the usual sense, but the cost is one buffer allocation and it removes any
 * argument about early-exit behaviour from the security review.
 */
export async function verifyArtifact(
  path: string,
  expectedSha256: string,
  expectedBytes?: number,
): Promise<VerificationResult> {
  const info = await stat(path);
  const actualSha256 = await hashFile(path);
  const actualBytes = info.size;

  if (typeof expectedBytes === 'number' && expectedBytes !== actualBytes) {
    return { verified: false, actualSha256, actualBytes, reason: 'model_artifact_size_mismatch' };
  }

  const expected = Buffer.from(String(expectedSha256).toLowerCase(), 'hex');
  const actual = Buffer.from(actualSha256, 'hex');
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!matches) {
    return { verified: false, actualSha256, actualBytes, reason: 'model_artifact_digest_mismatch' };
  }
  return { verified: true, actualSha256, actualBytes };
}

/** Human-readable size for the pre-download confirmation. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
