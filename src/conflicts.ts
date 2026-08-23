import { createHash } from 'node:crypto';

/**
 * Concurrent-edit conflict detection.
 *
 * The specification requires the harness to detect conflicting edits, and
 * nothing did. Locks exist and the write tool takes one, but a lock only
 * prevents two writes happening *at the same instant*. It does not prevent the
 * failure that actually loses work in a multi-agent system:
 *
 *   1. Agent A reads `notes.md`.
 *   2. Agent B takes the lock, writes `notes.md`, releases it.
 *   3. Agent A takes the lock and writes the content it derived from its
 *      now-stale read.
 *
 * Every step holds the lock correctly and B's work is silently gone. The lock
 * is released between A's read and A's write, which is exactly where the
 * conflict lives.
 *
 * Detection here is optimistic concurrency: a writer states the content it
 * believes it is replacing, and the harness refuses the write if reality has
 * moved on. That turns a silent clobber into a visible, resolvable failure.
 */

export const hashContent = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export type ConflictKind =
  /** Someone wrote the file after this writer read it. */
  | 'stale_base'
  /** The file changed outside the harness since it was last recorded. */
  | 'out_of_band'
  /** The writer expected to create a new file, but one already exists. */
  | 'unexpected_existing';

export interface Conflict {
  kind: ConflictKind;
  path: string;
  /** What the writer believed the current content was. */
  expected?: string;
  /** What the harness has on record. */
  recorded?: string;
  /** What is actually on disk right now. */
  actual?: string;
  detail: string;
}

export interface ConflictCheck {
  path: string;
  /** SHA-256 the writer believes it is replacing. Undefined means "no claim". */
  baseSha256?: string;
  /** SHA-256 the file registry last recorded, if the file is tracked. */
  recordedSha256?: string;
  /** SHA-256 of the bytes on disk right now, or undefined when absent. */
  actualSha256?: string;
}

/**
 * Decide whether a write conflicts.
 *
 * A writer that makes no claim about the base is allowed through: not every
 * write is a read-modify-write, and forcing a claim would make the common case
 * of creating a file awkward. The trade-off is deliberate and stated — callers
 * that care about losing a concurrent edit must supply `baseSha256`.
 */
export function detectConflict(check: ConflictCheck): Conflict | null {
  const { path, baseSha256, recordedSha256, actualSha256 } = check;

  // Out-of-band edits are checked first: if disk and the registry disagree, no
  // claim the writer makes about the base can be evaluated meaningfully.
  if (recordedSha256 && actualSha256 && recordedSha256 !== actualSha256) {
    return {
      kind: 'out_of_band',
      path,
      recorded: recordedSha256,
      actual: actualSha256,
      detail:
        'The file changed outside the harness since it was last recorded. Re-read it before writing.',
    };
  }

  if (!baseSha256) return null;

  // The writer expected to replace existing content, and there is none.
  if (!actualSha256 && !recordedSha256) {
    return {
      kind: 'stale_base',
      path,
      expected: baseSha256,
      detail: 'The writer expected existing content, but the file does not exist.',
    };
  }

  const current = actualSha256 ?? recordedSha256;
  if (current && current !== baseSha256) {
    return {
      kind: 'stale_base',
      path,
      expected: baseSha256,
      recorded: recordedSha256,
      actual: actualSha256,
      detail:
        'Another writer changed this file after it was read. Re-read it and reapply the change.',
    };
  }

  return null;
}

/**
 * A writer may state `baseSha256: null` to mean "I expect to create this file".
 * That is a different claim from making none, and it is worth honouring: it
 * catches two agents independently deciding to create the same file.
 */
export function detectCreateConflict(path: string, actualSha256?: string): Conflict | null {
  if (!actualSha256) return null;
  return {
    kind: 'unexpected_existing',
    path,
    actual: actualSha256,
    detail: 'The writer expected to create this file, but it already exists.',
  };
}

/** Render a conflict as the error a tool raises. */
export function conflictError(conflict: Conflict): Error {
  return new Error(`filesystem_write_denied:conflict:${conflict.kind}:${conflict.path}`);
}
