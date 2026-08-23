import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateDependencies, dependencyError } from '../src/dependencies.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ModelRouter } from '../src/router.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { MockLocalAdapter } from '../src/providers.js';
import { entity, type Model, type Task } from '../src/types.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';

/**
 * Tasks carry `dependencyIds`, the API validates them on creation, and until
 * now nothing looked at them again. A task declared to depend on another ran
 * the moment someone started it, so the ordering guarantee the field advertises
 * was never held.
 */

const task = (overrides: Partial<Task>): Task =>
  entity({
    kind: 'task',
    ownerId: 'u',
    scope: 'project-1',
    projectId: 'project-1',
    environmentId: 'env-1',
    title: 'T',
    description: 'd',
    acceptanceCriteria: [],
    status: 'ready',
    priority: 0,
    dependencyIds: [],
    labels: [],
    ...overrides,
  }) as Task;

const graph = (...tasks: Task[]) => new Map(tasks.map((item) => [item.id, item]));

describe('dependency evaluation', () => {
  it('allows a task with no dependencies', () => {
    expect(evaluateDependencies(task({}), graph()).runnable).toBe(true);
  });

  it('allows a task whose dependency is done', () => {
    const done = task({ status: 'done' });
    const dependent = task({ dependencyIds: [done.id] });
    expect(evaluateDependencies(dependent, graph(done, dependent)).runnable).toBe(true);
  });

  it('blocks a task whose dependency has not finished', () => {
    // The defect: this ran anyway.
    const pending = task({ status: 'ready' });
    const dependent = task({ dependencyIds: [pending.id] });
    const verdict = evaluateDependencies(dependent, graph(pending, dependent));
    expect(verdict.runnable).toBe(false);
    expect(verdict.blockedBy).toEqual([
      { taskId: pending.id, status: 'ready', reason: 'incomplete' },
    ]);
  });

  it('blocks on a running dependency, which is not the same as a finished one', () => {
    const running = task({ status: 'running' });
    const dependent = task({ dependencyIds: [running.id] });
    expect(evaluateDependencies(dependent, graph(running, dependent)).runnable).toBe(false);
  });

  it('distinguishes a dead end from work still to come', () => {
    // "not ready yet" and "never going to be ready" call for different action:
    // one is waiting, the other needs the dependency edge removed.
    const cancelled = task({ status: 'cancelled' });
    const dependent = task({ dependencyIds: [cancelled.id] });
    const verdict = evaluateDependencies(dependent, graph(cancelled, dependent));
    expect(verdict.blockedBy[0]?.reason).toBe('unreachable');
  });

  it('blocks on a dependency that has been deleted', () => {
    // Treating a dangling reference as satisfied would drop the ordering
    // guarantee at the exact moment it stopped being checkable.
    const dependent = task({ dependencyIds: ['task-gone'] });
    const verdict = evaluateDependencies(dependent, graph(dependent));
    expect(verdict.blockedBy).toEqual([{ taskId: 'task-gone', reason: 'missing' }]);
  });

  it('reports every blocker, not merely the first', () => {
    const a = task({ status: 'ready' });
    const b = task({ status: 'blocked' });
    const dependent = task({ dependencyIds: [a.id, b.id] });
    expect(evaluateDependencies(dependent, graph(a, b, dependent)).blockedBy).toHaveLength(2);
  });

  it('reports a self-dependency as a cycle', () => {
    const self = task({});
    self.dependencyIds = [self.id];
    const verdict = evaluateDependencies(self, graph(self));
    expect(verdict.blockedBy[0]?.reason).toBe('cycle');
  });

  it('reports a two-task cycle', () => {
    const a = task({});
    const b = task({ dependencyIds: [a.id] });
    a.dependencyIds = [b.id];
    expect(evaluateDependencies(a, graph(a, b)).blockedBy[0]?.reason).toBe('cycle');
  });

  it('reports a longer cycle', () => {
    const a = task({});
    const b = task({});
    const c = task({});
    a.dependencyIds = [b.id];
    b.dependencyIds = [c.id];
    c.dependencyIds = [a.id];
    expect(evaluateDependencies(a, graph(a, b, c)).blockedBy[0]?.reason).toBe('cycle');
  });

  it('does not mistake a diamond for a cycle', () => {
    // a -> b, a -> c, b -> d, c -> d. No cycle, and traversal must terminate.
    const d = task({ status: 'done' });
    const b = task({ status: 'done', dependencyIds: [d.id] });
    const c = task({ status: 'done', dependencyIds: [d.id] });
    const a = task({ dependencyIds: [b.id, c.id] });
    expect(evaluateDependencies(a, graph(a, b, c, d)).runnable).toBe(true);
  });

  it('does not walk transitive dependencies', () => {
    // A done dependency is trusted: it could not have reached done unless its
    // own dependencies were satisfied. Reporting a deep unrelated failure would
    // name a task the operator never touched.
    const deep = task({ status: 'ready' });
    const middle = task({ status: 'done', dependencyIds: [deep.id] });
    const top = task({ dependencyIds: [middle.id] });
    expect(evaluateDependencies(top, graph(deep, middle, top)).runnable).toBe(true);
  });
});

describe('the refusal is actionable', () => {
  it('names the blocking tasks and their states', () => {
    const pending = task({ status: 'ready' });
    const dependent = task({ dependencyIds: [pending.id, 'task-gone'] });
    const message = dependencyError(
      evaluateDependencies(dependent, graph(pending, dependent)),
    ).message;
    expect(message).toContain('dependencies_unmet');
    expect(message).toContain(pending.id);
    expect(message).toContain('ready');
    expect(message).toContain('deleted');
  });
});

describe('the orchestrator refuses to queue a blocked run', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-deps-'));
    const store = createStore(dir);
    const { project, agent, task: fixtureTask } = fixtures('execute');
    const model = entity({
      kind: 'model',
      ownerId: 'u',
      scope: project.id,
      providerId: 'provider-1',
      name: fixtureTask.title,
      modelName: agent.profile.allowedModels[0] ?? 'mock',
      local: true,
      capabilities: {
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embeddings: false,
        reranking: false,
        contextTokens: 8192,
        outputTokens: 2048,
      },
      inputCostPerMillionCents: 0,
      outputCostPerMillionCents: 0,
      available: true,
    }) as Model;
    for (const record of [project, agent, fixtureTask]) await store.insert(record);
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: (candidate) => new MockLocalAdapter(candidate.modelName),
    });
    return { store, orchestrator, project, agent, task: fixtureTask };
  }

  it('creates a run when dependencies are satisfied', async () => {
    const { orchestrator, project, agent, task: ready } = await setup();
    // The baseline: without it, the refusal below could pass because run
    // creation is broken outright.
    await expect(
      orchestrator.createRun({ ownerId: 'u', project, agent, task: ready }),
    ).resolves.toMatchObject({ status: 'queued' });
  });

  it('refuses when a dependency has not finished', async () => {
    const { store, orchestrator, project, agent, task: dependent } = await setup();
    const blocker = task({ projectId: project.id, scope: project.id, status: 'ready' });
    await store.insert(blocker);
    dependent.dependencyIds = [blocker.id];

    await expect(
      orchestrator.createRun({ ownerId: 'u', project, agent, task: dependent }),
    ).rejects.toThrow(/run_denied:dependencies_unmet/);
  });

  it('leaves no queued run behind when it refuses', async () => {
    const { store, orchestrator, project, agent, task: dependent } = await setup();
    const blocker = task({ projectId: project.id, scope: project.id, status: 'ready' });
    await store.insert(blocker);
    dependent.dependencyIds = [blocker.id];
    await orchestrator
      .createRun({ ownerId: 'u', project, agent, task: dependent })
      .catch(() => undefined);

    // Refusing after the record exists would leave the operator something to
    // clean up and make queue depth misreport how much work is runnable.
    const runs = await store.list((item) => item.kind === 'run');
    expect(runs).toHaveLength(0);
  });

  it('accepts the run once the dependency completes', async () => {
    const { store, orchestrator, project, agent, task: dependent } = await setup();
    const blocker = task({ projectId: project.id, scope: project.id, status: 'ready' });
    await store.insert(blocker);
    dependent.dependencyIds = [blocker.id];
    await expect(
      orchestrator.createRun({ ownerId: 'u', project, agent, task: dependent }),
    ).rejects.toThrow();

    await store.put<Task>({ ...blocker, status: 'done' });
    await expect(
      orchestrator.createRun({ ownerId: 'u', project, agent, task: dependent }),
    ).resolves.toMatchObject({ status: 'queued' });
  });
});
