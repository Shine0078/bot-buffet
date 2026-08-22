import { describe, expect, it } from 'vitest';
import { canWriteMemory, expiredMemoryItems, selectReadableMemory } from '../src/memoryScope.js';
import { entity, type MemoryItem, type MemoryPolicy } from '../src/types.js';

/**
 * `memoryPolicy` declared readable and writable scopes, approval, and
 * retention on every agent profile, and nothing read any of it — the
 * orchestrator never loaded memory into agent context at all, so the policy
 * governed a path that did not exist.
 *
 * The property that matters most here is the namespace-identity pairing:
 * permission to read the `project` namespace must mean *this run's* project,
 * not every project. Without that, a readable scope is a cross-tenant read.
 */

const scope = {
  ownerId: 'user-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  environmentId: 'env-1',
  agentId: 'agent-1',
  taskId: 'task-1',
  runId: 'run-1',
};

const policy = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy => ({
  readableScopes: ['project', 'agent', 'task'],
  writableScopes: ['task'],
  requireApproval: false,
  retentionDays: 0,
  ...overrides,
});

const memory = (overrides: Partial<MemoryItem> = {}): MemoryItem =>
  entity({
    kind: 'memory',
    ownerId: 'user-1',
    scope: 'project-1',
    namespace: 'project',
    namespaceId: 'project-1',
    text: 'remembered',
    sourceIds: [],
    approved: true,
    freshnessAt: new Date().toISOString(),
    ...overrides,
  }) as MemoryItem;

describe('readable namespace filtering', () => {
  it('includes memory in a readable namespace belonging to this run', () => {
    const item = memory();
    const result = selectReadableMemory([item], policy(), scope);
    expect(result.readable.map((entry) => entry.id)).toEqual([item.id]);
    expect(result.excluded).toEqual([]);
  });

  it('excludes a namespace the policy does not list', () => {
    const item = memory({ namespace: 'workspace', namespaceId: 'workspace-1' });
    const result = selectReadableMemory([item], policy(), scope);
    expect(result.readable).toEqual([]);
    expect(result.excluded[0]?.reason).toBe('namespace_not_readable');
  });

  it('includes a namespace once the policy lists it', () => {
    const item = memory({ namespace: 'workspace', namespaceId: 'workspace-1' });
    const result = selectReadableMemory([item], policy({ readableScopes: ['workspace'] }), scope);
    expect(result.readable).toHaveLength(1);
  });
});

describe('explicit memory expiry', () => {
  it('returns only records with a finite expiry at or before the cutoff', () => {
    const cutoff = Date.parse('2026-08-22T12:00:00.000Z');
    const expired = memory({ expiresAt: '2026-08-22T11:59:59.000Z' });
    const future = memory({ expiresAt: '2026-08-22T12:00:01.000Z' });
    const malformed = memory({ expiresAt: 'not-a-date' });
    const unbounded = memory();
    expect(expiredMemoryItems([expired, future, malformed, unbounded], cutoff)).toEqual([expired]);
  });
});

describe('namespace identity is the isolation boundary', () => {
  it('refuses another project memory even though the namespace is readable', () => {
    // The whole point: readable namespace, wrong instance of it.
    const item = memory({ namespaceId: 'project-2' });
    const result = selectReadableMemory([item], policy(), scope);
    expect(result.readable).toEqual([]);
    expect(result.excluded[0]?.reason).toBe('namespace_identity_mismatch');
  });

  it('refuses another agent, task, workspace, environment, and user memory', () => {
    const others: MemoryItem[] = [
      memory({ namespace: 'agent', namespaceId: 'agent-2' }),
      memory({ namespace: 'task', namespaceId: 'task-2' }),
      memory({ namespace: 'workspace', namespaceId: 'workspace-2' }),
      memory({ namespace: 'environment', namespaceId: 'env-2' }),
      memory({ namespace: 'user', namespaceId: 'user-2' }),
    ];
    const result = selectReadableMemory(
      others,
      policy({
        readableScopes: ['project', 'agent', 'task', 'workspace', 'environment', 'user'],
      }),
      scope,
    );
    expect(result.readable).toEqual([]);
    expect(result.excluded.every((entry) => entry.reason === 'namespace_identity_mismatch')).toBe(
      true,
    );
  });

  it('binds session memory to the run that produced it', () => {
    const mine = memory({ namespace: 'session', namespaceId: 'run-1' });
    const theirs = memory({ namespace: 'session', namespaceId: 'run-2' });
    const result = selectReadableMemory(
      [mine, theirs],
      policy({ readableScopes: ['session'] }),
      scope,
    );
    expect(result.readable.map((entry) => entry.id)).toEqual([mine.id]);
  });

  it('excludes namespaces that a run context cannot identify', () => {
    // `organization` and `artifact` have no run-scoped identity, so they are
    // excluded rather than let through unmatched.
    for (const namespace of ['organization', 'artifact'] as const) {
      const item = memory({ namespace, namespaceId: 'anything' });
      const result = selectReadableMemory([item], policy({ readableScopes: [namespace] }), scope);
      expect(result.readable, namespace).toEqual([]);
      expect(result.excluded[0]?.reason).toBe('namespace_identity_mismatch');
    }
  });

  it('excludes a scope the run does not have at all', () => {
    const item = memory({ namespace: 'task', namespaceId: 'task-1' });
    const result = selectReadableMemory([item], policy(), { ...scope, taskId: undefined });
    expect(result.readable).toEqual([]);
  });
});

describe('approval and lifetime', () => {
  it('excludes unapproved memory when the policy requires approval', () => {
    const item = memory({ approved: false });
    expect(selectReadableMemory([item], policy({ requireApproval: true }), scope).readable).toEqual(
      [],
    );
    expect(
      selectReadableMemory([item], policy({ requireApproval: false }), scope).readable,
    ).toHaveLength(1);
  });

  it('excludes memory that has expired', () => {
    const item = memory({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const result = selectReadableMemory([item], policy(), scope);
    expect(result.excluded[0]?.reason).toBe('expired');
  });

  it('keeps memory whose expiry is still ahead', () => {
    const item = memory({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(selectReadableMemory([item], policy(), scope).readable).toHaveLength(1);
  });

  it('excludes memory older than the retention window', () => {
    const old = memory({ freshnessAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    expect(
      selectReadableMemory([old], policy({ retentionDays: 7 }), scope).excluded[0]?.reason,
    ).toBe('beyond_retention');
    // Retention of zero means no limit rather than "nothing is readable".
    expect(selectReadableMemory([old], policy({ retentionDays: 0 }), scope).readable).toHaveLength(
      1,
    );
  });
});

describe('exclusions are reported', () => {
  it('records why each item was dropped, so a forgetful run can be explained', () => {
    const items = [
      memory({ namespace: 'workspace', namespaceId: 'workspace-1' }),
      memory({ namespaceId: 'project-2' }),
      memory({ approved: false }),
      memory(),
    ];
    const result = selectReadableMemory(items, policy({ requireApproval: true }), scope);
    expect(result.readable).toHaveLength(1);
    expect(result.excluded.map((entry) => entry.reason)).toEqual([
      'namespace_not_readable',
      'namespace_identity_mismatch',
      'not_approved',
    ]);
  });
});

describe('write scope is separate from read scope', () => {
  it('does not grant writes just because reads are permitted', () => {
    // The common configuration is a broad read scope with a narrow write scope.
    const current = policy();
    expect(current.readableScopes).toContain('project');
    expect(canWriteMemory(current, 'project')).toBe(false);
    expect(canWriteMemory(current, 'task')).toBe(true);
  });

  it('refuses a namespace absent from the write scopes', () => {
    for (const namespace of ['user', 'workspace', 'agent', 'session'] as const) {
      expect(canWriteMemory(policy(), namespace), namespace).toBe(false);
    }
  });
});
