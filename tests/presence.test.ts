import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePresence } from '../src/presence.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ModelRouter } from '../src/router.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { MockLocalAdapter } from '../src/providers.js';
import { entity, type Agent, type Model, type Run, type RunStatus } from '../src/types.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';

/**
 * Agent.status, currentRunId, and currentTaskId were declared and written by
 * nothing. An agent read as `idle` mid-run, while waiting on an approval nobody
 * knew to give, and after it had failed -- so "what is this desk doing right
 * now" had no answer anywhere in the system.
 */

let sequence = 0;
const run = (status: RunStatus, taskId = 'task-1'): Run =>
  ({
    ...(entity({
      kind: 'run',
      ownerId: 'u',
      scope: 'project-1',
      projectId: 'project-1',
      environmentId: 'env-1',
      agentId: 'agent-1',
      taskId,
      mode: 'supervised',
      status,
      stepCount: 0,
      maxSteps: 4,
      cancelRequested: false,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
    }) as Run),
    // Distinct, increasing timestamps: "most recent finished run" is otherwise
    // decided by tie-break rather than by the thing being tested.
    updatedAt: new Date(1_700_000_000_000 + ++sequence * 1000).toISOString(),
  }) as Run;

describe('presence derivation', () => {
  it('reports idle when there are no runs', () => {
    expect(derivePresence([])).toMatchObject({ status: 'idle' });
  });

  it('reports working for a running run, and names it', () => {
    const active = run('running');
    expect(derivePresence([active])).toEqual({
      status: 'working',
      currentRunId: active.id,
      currentTaskId: active.taskId,
    });
  });

  it('claims the desk as soon as a run is queued', () => {
    // The desk is spoken for before the first step executes.
    expect(derivePresence([run('queued')]).status).toBe('working');
  });

  it('surfaces a waiting approval over concurrent work', () => {
    // An agent running three things where one needs a decision is, to the
    // operator, an agent that needs a decision. Reporting `working` would bury
    // the only state that requires a person.
    const waiting = run('waiting_approval', 'task-2');
    const presence = derivePresence([run('running'), waiting, run('running')]);
    expect(presence.status).toBe('waiting_approval');
    expect(presence.currentRunId).toBe(waiting.id);
    expect(presence.currentTaskId).toBe('task-2');
  });

  it('surfaces blocked ahead of running', () => {
    expect(derivePresence([run('running'), run('blocked')]).status).toBe('blocked');
  });

  it('reports paused and retrying distinctly', () => {
    expect(derivePresence([run('paused')]).status).toBe('paused');
    expect(derivePresence([run('retrying')]).status).toBe('retrying');
  });

  it('returns to idle once a run completes', () => {
    const presence = derivePresence([run('completed')]);
    expect(presence.status).toBe('idle');
    // The desk must stop pointing at finished work, or the UI keeps offering a
    // run that is over.
    expect(presence.currentRunId).toBeUndefined();
    expect(presence.currentTaskId).toBeUndefined();
  });

  it('keeps a failure visible rather than folding it into idle', () => {
    // A desk that stopped badly should not look like one that simply has no
    // work.
    expect(derivePresence([run('failed')]).status).toBe('failed');
  });

  it('does not report completed as an agent status', () => {
    // `completed` describes a run, not a desk. An agent that finished
    // successfully is available, not retired.
    expect(derivePresence([run('completed')]).status).not.toBe('completed');
  });

  it('lets live work outrank an earlier failure', () => {
    const failed = run('failed');
    const active = run('running');
    expect(derivePresence([failed, active]).status).toBe('working');
  });

  it('reports only the most recent finished run', () => {
    const failed = run('failed');
    const later = run('completed');
    expect(derivePresence([failed, later]).status).toBe('idle');
    expect(derivePresence([later, failed]).status).toBe('idle');
  });

  it('reports the most recent failure when it is the latest', () => {
    const completed = run('completed');
    const failed = run('failed');
    expect(derivePresence([completed, failed]).status).toBe('failed');
  });
});

describe('the orchestrator keeps the agent record in step', () => {
  async function setup(options: { verifiable?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-presence-'));
    const store = createStore(dir);
    const { project, agent, task } = fixtures('execute');
    const model = entity({
      kind: 'model',
      ownerId: 'u',
      scope: project.id,
      providerId: 'provider-1',
      name: 'm',
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
    if (options.verifiable) {
      // The default fixture fails verification and the profile escalates to
      // paused, so it can never show release. An explicitly empty policy with
      // requireEvidence false verifies nothing and says so -- the legitimate
      // configuration for an agent with no acceptance criteria.
      agent.profile.verificationPolicy = {
        deterministic: [],
        inferential: [],
        requireEvidence: false,
      };
      task.acceptanceCriteria = [];
    }
    // The model must be stored, not merely offered by the router: the
    // orchestrator resolves the routed choice back through the store.
    for (const record of [project, agent, model, task]) await store.insert(record);
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: (candidate) => new MockLocalAdapter(candidate.modelName),
    });
    return { store, orchestrator, project, agent, task };
  }

  it('starts from idle', async () => {
    const { store, agent } = await setup();
    // Baseline: without it, a later assertion of a non-idle status could pass
    // for the wrong reason.
    expect((await store.get<Agent>(agent.id))?.status).toBe('idle');
  });

  it('claims the agent when a run is queued', async () => {
    const { store, orchestrator, project, agent, task } = await setup();
    const created = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    const stored = await store.get<Agent>(agent.id);
    expect(stored?.status).toBe('working');
    expect(stored?.currentRunId).toBe(created.id);
    expect(stored?.currentTaskId).toBe(task.id);
  });

  it('holds the agent on a run that pauses rather than finishing', async () => {
    const { store, orchestrator, project, agent, task } = await setup();
    const created = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    // Pause is an operator command, not a verification outcome. Failed
    // verification either completes or fails the run; occupancy after a
    // deliberate pause is what this test has to prove.
    await orchestrator.command({ runId: created.id, type: 'pause' });
    const finished = await store.get<Run>(created.id);
    const stored = await store.get<Agent>(agent.id);
    expect(finished?.status).toBe('paused');
    expect(stored?.status).toBe('paused');
    expect(stored?.currentRunId).toBe(created.id);
  });

  it('releases the agent once a run genuinely completes', async () => {
    const { store, orchestrator, project, agent, task } = await setup({ verifiable: true });
    const created = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(created.id);

    const finished = await store.get<Run>(created.id);
    const stored = await store.get<Agent>(agent.id);
    expect(finished?.status).toBe('completed');
    expect(stored?.status).toBe('idle');
    // The desk must stop pointing at finished work, or the UI keeps offering a
    // run that is over.
    expect(stored?.currentRunId).toBeUndefined();
    expect(stored?.currentTaskId).toBeUndefined();
  });

  it('does not fail a run when the presence write fails', async () => {
    const { store, orchestrator, project, agent, task } = await setup({ verifiable: true });
    const realPut = store.put.bind(store);
    // Break the presence write specifically. Deleting the agent would not test
    // this: the run would fail on run_context_missing for an unrelated and
    // entirely legitimate reason, and the test would pass without the swallow
    // ever being exercised.
    store.put = (async (value: { kind?: string }) => {
      if (value.kind === 'agent') throw new Error('presence_store_unavailable');
      return realPut(value as never);
    }) as typeof store.put;

    // Presence is reporting. Losing it costs visibility; throwing would turn a
    // cosmetic problem into a lost run.
    const created = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await expect(orchestrator.start(created.id)).resolves.toBeUndefined();

    // The run still reached its real conclusion; only the reporting was lost.
    expect((await store.get<Run>(created.id))?.status).toBe('completed');
    store.put = realPut;
  });

  it('does not complete when inferential review names a missing agent', async () => {
    const { store, orchestrator, project, agent, task } = await setup({ verifiable: true });
    agent.profile.verificationPolicy = {
      deterministic: [],
      inferential: ['llm-judge'],
      requireEvidence: false,
      reviewerAgentId: 'missing-reviewer',
    };
    await store.put(agent);
    const created = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(created.id);
    expect((await store.get<Run>(created.id))?.status).not.toBe('completed');
  });
});
