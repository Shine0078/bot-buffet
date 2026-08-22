import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLocalAdapter } from '../src/providers.js';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { entity, type Checkpoint, type Run } from '../src/types.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';

/**
 * Run control: pause, resume, cancel, stop, fork, and rollback.
 *
 * These are the operator's levers over work already in flight, and the
 * acceptance criteria require every one of them. The properties worth pinning
 * are the ones an operator would be harmed by getting wrong: a fork must not
 * disturb its parent, a rollback must restore the state that was checkpointed
 * rather than merely relabel the run, and neither may cross from one run into
 * another's checkpoints.
 */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-control-'));
  await writeFile(join(dir, 'repository'), 'contents');
  const store = createStore(dir);
  const { project, agent, model, task } = fixtures('execute');
  for (const record of [project, agent, model, task]) await store.insert(record);
  const orchestrator = new Orchestrator({
    store,
    router: new ModelRouter(async () => [model]),
    tools: createBuiltinTools(store),
    workspaceRoot: () => dir,
    adapters: () => new MockLocalAdapter('m'),
  });
  const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
  return { store, orchestrator, run, project, agent, task };
}

const checkpointFor = (runId: string, sequence: number, state: Record<string, unknown>) =>
  entity({
    kind: 'checkpoint',
    ownerId: 'u',
    scope: 'p',
    runId,
    sequence,
    state,
    stateHash: 'hash',
  }) as Checkpoint;

describe('unknown runs', () => {
  it('returns nothing rather than throwing', async () => {
    const { orchestrator } = await harness();
    await expect(orchestrator.command({ runId: 'no-such-run', type: 'pause' })).resolves.toBe(
      undefined,
    );
  });
});

describe('pause and resume', () => {
  it('pauses a run and records when', async () => {
    const { orchestrator, run } = await harness();
    const paused = await orchestrator.command({ runId: run.id, type: 'pause' });
    expect(paused?.status).toBe('paused');
    expect(paused?.pausedAt).toBeTruthy();
  });

  it('clears the paused marker on resume', async () => {
    const { orchestrator, run } = await harness();
    await orchestrator.command({ runId: run.id, type: 'pause' });
    const resumed = await orchestrator.command({ runId: run.id, type: 'resume' });
    expect(resumed?.pausedAt).toBeUndefined();
    // Resume hands the run back to the executor, so it is no longer paused.
    expect(resumed?.status).not.toBe('paused');
  });
});

describe('cancel and stop', () => {
  it('marks the run cancelled and finished', async () => {
    const { orchestrator, run } = await harness();
    const cancelled = await orchestrator.command({ runId: run.id, type: 'cancel' });
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelRequested).toBe(true);
    expect(cancelled?.finishedAt).toBeTruthy();
  });

  it('treats stop the same way as cancel', async () => {
    const { orchestrator, run } = await harness();
    const stopped = await orchestrator.command({ runId: run.id, type: 'stop' });
    expect(stopped?.status).toBe('cancelled');
    expect(stopped?.cancelRequested).toBe(true);
  });
});

describe('fork', () => {
  it('creates a new run that points back at its parent', async () => {
    const { orchestrator, run } = await harness();
    const fork = await orchestrator.command({ runId: run.id, type: 'fork' });
    expect(fork?.id).not.toBe(run.id);
    expect(fork?.parentRunId).toBe(run.id);
    expect(fork?.status).toBe('queued');
  });

  it('starts the fork clean rather than inheriting the parent outcome', async () => {
    const { store, orchestrator, run } = await harness();
    await store.put({ ...run, status: 'failed', error: 'boom', version: run.version } as Run);
    const fork = await orchestrator.command({ runId: run.id, type: 'fork' });
    expect(fork?.error).toBeUndefined();
    expect(fork?.finishedAt).toBeUndefined();
    expect(fork?.startedAt).toBeUndefined();
    expect(fork?.cancelRequested).toBe(false);
  });

  it('leaves the parent untouched', async () => {
    const { store, orchestrator, run } = await harness();
    await orchestrator.command({ runId: run.id, type: 'fork' });
    const parent = await store.get<Run>(run.id);
    expect(parent?.parentRunId).toBeUndefined();
    expect(parent?.status).toBe(run.status);
  });

  it('forks from a checkpoint, carrying its state and step count', async () => {
    const { store, orchestrator, run } = await harness();
    const checkpoint = checkpointFor(run.id, 7, { note: 'state at seven' });
    await store.insert(checkpoint);

    const fork = await orchestrator.command({
      runId: run.id,
      type: 'fork',
      checkpointId: checkpoint.id,
    });
    expect(fork?.stepCount).toBe(7);
    expect(fork?.checkpointId).toBe(checkpoint.id);
    await expect(store.getRunState(fork!.id)).resolves.toEqual({ note: 'state at seven' });
  });

  it('refuses a checkpoint belonging to another run', async () => {
    // Otherwise a fork could be seeded with state the caller was never
    // entitled to read.
    const { store, orchestrator, run } = await harness();
    const foreign = checkpointFor('some-other-run', 3, { secret: 'not yours' });
    await store.insert(foreign);
    await expect(
      orchestrator.command({ runId: run.id, type: 'fork', checkpointId: foreign.id }),
    ).rejects.toThrow(/checkpoint_scope_mismatch/);
  });

  it('refuses a checkpoint that does not exist', async () => {
    const { orchestrator, run } = await harness();
    await expect(
      orchestrator.command({ runId: run.id, type: 'fork', checkpointId: 'missing' }),
    ).rejects.toThrow(/checkpoint_scope_mismatch/);
  });
});

describe('rollback', () => {
  it('restores the checkpointed state rather than only relabelling the run', async () => {
    const { store, orchestrator, run } = await harness();
    await store.setRunState(run.id, { note: 'current, unwanted' });
    const checkpoint = checkpointFor(run.id, 2, { note: 'the good state' });
    await store.insert(checkpoint);

    const rolled = await orchestrator.command({
      runId: run.id,
      type: 'rollback',
      checkpointId: checkpoint.id,
    });
    expect(rolled?.status).toBe('rolled_back');
    await expect(store.getRunState(run.id)).resolves.toEqual({ note: 'the good state' });
  });

  it('refuses a checkpoint belonging to another run', async () => {
    const { store, orchestrator, run } = await harness();
    const foreign = checkpointFor('another-run', 1, { secret: 'not yours' });
    await store.insert(foreign);
    await expect(
      orchestrator.command({ runId: run.id, type: 'rollback', checkpointId: foreign.id }),
    ).rejects.toThrow(/checkpoint_scope_mismatch/);
  });

  it('leaves state alone when no checkpoint is named', async () => {
    const { store, orchestrator, run } = await harness();
    await store.setRunState(run.id, { note: 'unchanged' });
    const rolled = await orchestrator.command({ runId: run.id, type: 'rollback' });
    expect(rolled?.status).toBe('rolled_back');
    await expect(store.getRunState(run.id)).resolves.toEqual({ note: 'unchanged' });
  });
});

describe('run control keeps the record consistent', () => {
  it('keeps the audit chain verifiable through every command', async () => {
    const { store, orchestrator, run } = await harness();
    const checkpoint = checkpointFor(run.id, 1, { note: 'x' });
    await store.insert(checkpoint);
    for (const type of ['pause', 'resume', 'fork', 'rollback', 'cancel'] as const) {
      await orchestrator.command({ runId: run.id, type, checkpointId: undefined });
    }
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });
});
