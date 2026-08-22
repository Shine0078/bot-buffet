import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleContext, memoryToContext } from '../src/context.js';
import { createStore } from '../src/store.js';
import { Checkpoint, MemoryItem, Project, Run, entity } from '../src/types.js';

/**
 * The acceptance criteria require project state to survive context compaction, process restart,
 * and run failure. A restart is simulated by discarding the store instance and opening a new one
 * over the same directory, which is exactly what a crashed and relaunched process does.
 */
const reopen = (dir: string) => createStore(dir);

const memory = (id: string, text: string, relevance: number): MemoryItem =>
  entity({
    kind: 'memory',
    ownerId: 'u',
    scope: 'p1',
    namespace: 'project',
    namespaceId: 'p1',
    text,
    approved: true,
    relevance,
    sourceIds: [`source-${id}`],
    freshnessAt: '2026-08-20T00:00:00.000Z',
  }) as MemoryItem;

describe('durability across restart, compaction, and failure', () => {
  it('recovers projects, runs, and checkpoints from disk after a simulated restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-durability-'));
    const project = entity({
      kind: 'project',
      ownerId: 'u',
      scope: 'w',
      workspaceId: 'w',
      name: 'Durable',
      slug: 'durable',
      archived: false,
    }) as Project;
    const run = entity({
      kind: 'run',
      ownerId: 'u',
      scope: project.id,
      projectId: project.id,
      environmentId: 'e',
      agentId: 'a',
      mode: 'execute',
      status: 'running',
      stepCount: 3,
      maxSteps: 10,
      tokensIn: 40,
      tokensOut: 12,
      costCents: 2,
      latencyMs: 90,
    }) as Run;
    const checkpoint = entity({
      kind: 'checkpoint',
      ownerId: 'u',
      scope: project.id,
      runId: run.id,
      sequence: 3,
      stateHash: 'a'.repeat(64),
      state: { todo: ['finish the report'], done: ['gather sources'] },
      files: [],
      createdBy: 'system',
    }) as Checkpoint;

    const first = createStore(dir);
    for (const item of [project, run, checkpoint]) await first.insert(item);
    expect((await first.verifyAuditChain()).valid).toBe(true);

    // Simulated crash: nothing is flushed explicitly, the instance is simply abandoned.
    const second = reopen(dir);
    const recoveredRun = await second.get<Run>(run.id);
    expect(recoveredRun).toMatchObject({ status: 'running', stepCount: 3, tokensIn: 40 });
    const recoveredCheckpoint = await second.get<Checkpoint>(checkpoint.id);
    expect(recoveredCheckpoint?.state).toEqual({
      todo: ['finish the report'],
      done: ['gather sources'],
    });
    expect((await second.verifyAuditChain()).valid).toBe(true);
  });

  it('keeps durable progress outside the model context when compaction drops items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-durability-'));
    const store = createStore(dir);
    const items = [
      memory('keep', 'the release gate blocks on regressions', 1),
      memory('drop', 'verbose background detail '.repeat(40), 0.05),
    ];
    for (const item of items) await store.insert(item);

    const assembled = assembleContext(
      items.map((item, index) => memoryToContext(item, index === 0 ? 1 : 0.05)),
      48,
    );
    expect(assembled.compacted).toBe(true);
    expect(assembled.omittedIds.length).toBeGreaterThan(0);

    // The compacted-out memory must still exist durably; compaction is a context decision only.
    const reopened = reopen(dir);
    for (const omitted of assembled.omittedIds) {
      const survivor = await reopened.get<MemoryItem>(omitted);
      expect(survivor?.text).toBeTruthy();
    }
    expect((await reopened.list((x) => x.kind === 'memory')).length).toBe(items.length);
  });

  it('preserves the last checkpoint when a run fails so work can resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-durability-'));
    const store = createStore(dir);
    const run = entity({
      kind: 'run',
      ownerId: 'u',
      scope: 'p1',
      projectId: 'p1',
      environmentId: 'e',
      agentId: 'a',
      mode: 'execute',
      status: 'running',
      stepCount: 2,
      maxSteps: 10,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
      latencyMs: 0,
    }) as Run;
    await store.insert(run);
    const checkpoint = entity({
      kind: 'checkpoint',
      ownerId: 'u',
      scope: 'p1',
      runId: run.id,
      sequence: 2,
      stateHash: 'b'.repeat(64),
      state: { todo: ['resume here'] },
      files: [],
      createdBy: 'system',
    }) as Checkpoint;
    await store.insert(checkpoint);
    await store.put({ ...run, status: 'failed', error: 'model_unavailable' });

    const reopened = reopen(dir);
    const failed = await reopened.get<Run>(run.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'model_unavailable' });
    const checkpoints = await reopened.list<Checkpoint>(
      (x) => x.kind === 'checkpoint' && (x as Checkpoint).runId === run.id,
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.state).toEqual({ todo: ['resume here'] });
    expect((await reopened.verifyAuditChain()).valid).toBe(true);
  });
});
