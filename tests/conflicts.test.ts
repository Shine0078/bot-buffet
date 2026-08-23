import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conflictError,
  detectConflict,
  detectCreateConflict,
  hashContent,
} from '../src/conflicts.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools, type ToolContext } from '../src/tools.js';
import { entity, type AuditEvent, type ProjectFile } from '../src/types.js';

/**
 * The specification requires the harness to detect conflicting edits, and
 * nothing did.
 *
 * A lock is not detection. It prevents two writes at the same instant; it does
 * not prevent the failure that actually loses work: agent A reads a file,
 * agent B takes the lock and writes it, then agent A takes the lock and writes
 * content derived from its now-stale read. Every step holds the lock
 * correctly and B's work is gone.
 */

const A = hashContent('version A');
const B = hashContent('version B');

describe('stale base detection', () => {
  it('allows a write whose base matches what is on disk', () => {
    expect(
      detectConflict({ path: 'notes.md', baseSha256: A, recordedSha256: A, actualSha256: A }),
    ).toBeNull();
  });

  it('refuses a write whose base is out of date', () => {
    // This is the clobber: the writer read version A, someone wrote B, and the
    // writer is now trying to replace what it thinks is still A.
    const conflict = detectConflict({
      path: 'notes.md',
      baseSha256: A,
      recordedSha256: B,
      actualSha256: B,
    });
    expect(conflict?.kind).toBe('stale_base');
    expect(conflict?.expected).toBe(A);
    expect(conflict?.actual).toBe(B);
    expect(conflict?.detail).toMatch(/re-read/i);
  });

  it('refuses a write that expected content where the file does not exist', () => {
    const conflict = detectConflict({ path: 'gone.md', baseSha256: A });
    expect(conflict?.kind).toBe('stale_base');
    expect(conflict?.detail).toMatch(/does not exist/i);
  });

  it('allows a write that makes no claim about the base', () => {
    // Deliberate: not every write is read-modify-write, and requiring a claim
    // would make simple creation awkward. Callers that care supply a base.
    expect(detectConflict({ path: 'new.md' })).toBeNull();
    expect(detectConflict({ path: 'new.md', recordedSha256: A, actualSha256: A })).toBeNull();
  });
});

describe('out-of-band edit detection', () => {
  it('refuses when the file changed outside the harness', () => {
    const conflict = detectConflict({
      path: 'notes.md',
      baseSha256: A,
      recordedSha256: A,
      actualSha256: B,
    });
    expect(conflict?.kind).toBe('out_of_band');
  });

  it('is checked before the base claim, since a diverged file makes it meaningless', () => {
    // Both conditions hold here; out-of-band must win, because the writer's
    // claim cannot be evaluated against a file the registry no longer knows.
    const conflict = detectConflict({
      path: 'notes.md',
      baseSha256: hashContent('something else'),
      recordedSha256: A,
      actualSha256: B,
    });
    expect(conflict?.kind).toBe('out_of_band');
  });

  it('does not fire when the registry has no record yet', () => {
    expect(detectConflict({ path: 'new.md', actualSha256: A })).toBeNull();
  });
});

describe('create conflicts', () => {
  it('refuses to create over an existing file', () => {
    // Two agents independently deciding to create the same file.
    const conflict = detectCreateConflict('notes.md', A);
    expect(conflict?.kind).toBe('unexpected_existing');
  });

  it('allows creation when nothing is there', () => {
    expect(detectCreateConflict('notes.md', undefined)).toBeNull();
  });
});

describe('conflict errors', () => {
  it('names the kind and the path so the failure is actionable', () => {
    const error = conflictError({
      kind: 'stale_base',
      path: 'notes.md',
      detail: 'x',
    });
    expect(error.message).toContain('conflict:stale_base');
    expect(error.message).toContain('notes.md');
  });
});

describe('the write tool enforces it', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-conflict-'));
    const store = createStore(dir);
    const tools = createBuiltinTools(store);
    const context: ToolContext = {
      actorId: 'user-1',
      runId: 'run-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceRoot: dir,
      allowedPaths: ['.'],
      protectedPaths: [],
      network: 'blocked',
    };
    return { dir, store, tools, context };
  }

  it('writes when the base matches the file on disk', async () => {
    const { dir, tools, context } = await setup();
    await writeFile(join(dir, 'notes.md'), 'version A');
    await expect(
      tools.invoke(
        'filesystem.write',
        { path: 'notes.md', content: 'version C', baseSha256: A },
        context,
      ),
    ).resolves.toMatchObject({ path: 'notes.md' });
  });

  it('refuses the classic clobber and leaves the other write intact', async () => {
    const { dir, tools, context } = await setup();
    // Agent B has already written version B; agent A still believes it is A.
    await writeFile(join(dir, 'notes.md'), 'version B');
    await expect(
      tools.invoke(
        'filesystem.write',
        { path: 'notes.md', content: 'derived from stale A', baseSha256: A },
        context,
      ),
    ).rejects.toThrow(/conflict:stale_base/);

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('version B');
  });

  it('refuses to create over an existing file when the writer expected a new one', async () => {
    const { dir, tools, context } = await setup();
    await writeFile(join(dir, 'notes.md'), 'already here');
    await expect(
      tools.invoke(
        'filesystem.write',
        { path: 'notes.md', content: 'mine', expectNew: true },
        context,
      ),
    ).rejects.toThrow(/conflict:unexpected_existing/);
  });

  it('detects an out-of-band edit against the file registry', async () => {
    const { dir, store, tools, context } = await setup();
    await writeFile(join(dir, 'notes.md'), 'version B');
    // The registry still believes the file is version A.
    await store.insert(
      entity({
        kind: 'file',
        ownerId: 'user-1',
        scope: 'project-1',
        projectId: 'project-1',
        path: 'notes.md',
        sha256: A,
        size: 9,
        versionLabel: 'v1',
      }) as ProjectFile,
    );
    await expect(
      tools.invoke(
        'filesystem.write',
        { path: 'notes.md', content: 'anything', baseSha256: A },
        context,
      ),
    ).rejects.toThrow(/conflict:out_of_band/);
  });

  it('still allows a write that makes no base claim', async () => {
    const { tools, context } = await setup();
    await expect(
      tools.invoke('filesystem.write', { path: 'fresh.md', content: 'hello' }, context),
    ).resolves.toBeTruthy();
  });

  it('audits a refused write so the conflict is visible afterwards', async () => {
    const { dir, store, tools, context } = await setup();
    await writeFile(join(dir, 'notes.md'), 'version B');
    await tools
      .invoke('filesystem.write', { path: 'notes.md', content: 'x', baseSha256: A }, context)
      .catch(() => undefined);

    const events = await store.list<AuditEvent>(
      (x) => x.kind === 'audit-event' && (x as AuditEvent).action === 'filesystem.write_conflict',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.decision).toBe('denied');
    expect(events[0]?.metadata).toMatchObject({ kind: 'stale_base', path: 'notes.md' });
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });
});
