import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createBuiltinTools, type ToolContext } from '../src/tools.js';
import type { AuditEvent, MemoryItem, MemoryPolicy } from '../src/types.js';

/**
 * The agent-facing memory write.
 *
 * `writableScopes` governed a path that did not exist: agents had no way to
 * record anything, so the policy's write half was unenforceable by
 * construction. This is that path, and the tests are mostly about what it
 * refuses.
 */

const policy = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy => ({
  readableScopes: ['project', 'agent', 'task'],
  writableScopes: ['task'],
  requireApproval: false,
  retentionDays: 0,
  ...overrides,
});

/** Pass null to model an agent invoked with no memory policy at all; a
 *  default parameter would swallow an explicit undefined. */
async function setup(supplied: MemoryPolicy | null = policy()) {
  const memoryPolicy = supplied ?? undefined;
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-memtool-'));
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
    memoryPolicy,
  };
  return { store, tools, context };
}

describe('memory.write authority', () => {
  it('records a note in a writable namespace', async () => {
    const { store, tools, context } = await setup();
    const result = (await tools.invoke(
      'memory.write',
      { namespace: 'task', text: 'the fixture seeds two users' },
      context,
    )) as { id: string; namespaceId: string; approved: boolean };

    expect(result.namespaceId).toBe('task-1');
    expect(result.approved).toBe(true);
    const stored = await store.get<MemoryItem>(result.id);
    expect(stored?.text).toBe('the fixture seeds two users');
  });

  it('refuses a namespace the policy does not allow writing', async () => {
    const { tools, context } = await setup();
    // The policy reads project memory but only writes task memory.
    await expect(
      tools.invoke('memory.write', { namespace: 'project', text: 'x' }, context),
    ).rejects.toThrow(/namespace_not_writable/);
  });

  it('refuses entirely when no policy is supplied', async () => {
    // No policy means no authority, rather than defaulting to permitted.
    const { tools, context } = await setup(null);
    await expect(
      tools.invoke('memory.write', { namespace: 'task', text: 'x' }, context),
    ).rejects.toThrow(/no_policy/);
  });

  it('refuses a namespace the run cannot resolve', async () => {
    const { tools, context } = await setup(policy({ writableScopes: ['task'] }));
    await expect(
      tools.invoke(
        'memory.write',
        { namespace: 'task', text: 'x' },
        {
          ...context,
          taskId: undefined,
        },
      ),
    ).rejects.toThrow(/namespace_unresolved/);
  });

  it('rejects a namespace outside the tool schema', async () => {
    const { tools, context } = await setup(policy({ writableScopes: ['workspace'] }));
    // Schema validation refuses it before authority is even consulted.
    await expect(
      tools.invoke('memory.write', { namespace: 'workspace', text: 'x' }, context),
    ).rejects.toThrow(/tool_input_invalid/);
  });
});

describe('memory.write identity binding', () => {
  it('takes the namespace identity from the run, never from the caller', async () => {
    const { tools, context } = await setup(
      policy({ writableScopes: ['project', 'agent', 'task'] }),
    );
    for (const [namespace, expected] of [
      ['project', 'project-1'],
      ['agent', 'agent-1'],
      ['task', 'task-1'],
    ] as const) {
      const result = (await tools.invoke(
        'memory.write',
        // A caller-supplied namespaceId is not even accepted by the schema.
        { namespace, text: `note for ${namespace}` },
        context,
      )) as { namespaceId: string };
      expect(result.namespaceId, namespace).toBe(expected);
    }
  });

  it('binds session memory to the run', async () => {
    const { tools, context } = await setup(policy({ writableScopes: ['session'] }));
    const result = (await tools.invoke(
      'memory.write',
      { namespace: 'session', text: 'scratch' },
      context,
    )) as { namespaceId: string };
    expect(result.namespaceId).toBe('run-1');
  });
});

describe('approval before persistence', () => {
  it('stores the note unapproved when the policy requires approval', async () => {
    const { store, tools, context } = await setup(policy({ requireApproval: true }));
    const result = (await tools.invoke(
      'memory.write',
      { namespace: 'task', text: 'needs a human' },
      context,
    )) as { id: string; approved: boolean };

    // Recorded either way so nothing is lost, but unapproved keeps it out of
    // agent context until a human accepts it.
    expect(result.approved).toBe(false);
    expect((await store.get<MemoryItem>(result.id))?.approved).toBe(false);
  });
});

describe('memory.write hygiene', () => {
  it('refuses empty or whitespace-only text', async () => {
    const { tools, context } = await setup();
    for (const text of ['', '   ', '\n\t']) {
      await expect(
        tools.invoke('memory.write', { namespace: 'task', text }, context),
      ).rejects.toThrow(/memory_write_denied:empty|tool_input_invalid/);
    }
  });

  it('bounds the recorded text', async () => {
    const { store, tools, context } = await setup();
    const result = (await tools.invoke(
      'memory.write',
      { namespace: 'task', text: 'x'.repeat(10_000) },
      context,
    )) as { id: string };
    expect((await store.get<MemoryItem>(result.id))?.text).toHaveLength(4000);
  });

  it('audits every write and keeps the audit chain verifiable', async () => {
    const { store, tools, context } = await setup();
    await tools.invoke('memory.write', { namespace: 'task', text: 'audited' }, context);
    const events = await store.list<AuditEvent>(
      (x) => x.kind === 'audit-event' && (x as AuditEvent).action === 'memory.written',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ namespace: 'task', runId: 'run-1' });
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });
});
