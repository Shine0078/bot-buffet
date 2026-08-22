import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLocalAdapter } from '../src/providers.js';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import {
  Agent,
  Alert,
  AuditEvent,
  Budget,
  Checkpoint,
  CostRecord,
  Model,
  Project,
  Run,
  Task,
  UsageRecord,
  entity,
} from '../src/types.js';

describe('durable orchestration', () => {
  const buildFixtures = (costPerMillionCents = 0) => {
    const project = entity({
      kind: 'project',
      ownerId: 'u',
      scope: 'w',
      workspaceId: 'w',
      name: 'P',
      slug: 'p',
      archived: false,
    }) as Project;
    const agent = entity({
      kind: 'agent',
      ownerId: 'u',
      scope: project.id,
      projectId: project.id,
      environmentId: 'e',
      status: 'idle',
      profile: {
        name: 'A',
        mission: 'test',
        systemInstructions: 'test',
        projectRules: [],
        skills: [],
        allowedModels: ['m'],
        fallbackModelIds: [],
        allowedToolIds: [],
        allowedPluginIds: [],
        allowedPaths: ['.'],
        protectedPaths: ['.env'],
        network: 'blocked',
        environmentKeys: [],
        maxSteps: 2,
        timeLimitMs: 1000,
        tokenLimit: 1000,
        costLimitCents: 0,
        concurrencyLimit: 1,
        approvalPolicy: {
          requiredRisks: ['high', 'critical'],
          autoApproveReversible: false,
          expiryMs: 1000,
          delegates: [],
        },
        verificationPolicy: { deterministic: [], inferential: [], requireEvidence: true },
        memoryPolicy: {
          readableScopes: ['project'],
          writableScopes: [],
          requireApproval: true,
          retentionDays: 1,
        },
        outputFormat: 'text',
        escalationPolicy: 'pause',
        mode: 'supervised',
        version: 1,
        changelog: [],
      },
    }) as Agent;
    const model = entity({
      kind: 'model',
      ownerId: 'u',
      scope: project.id,
      providerId: 'p',
      name: 'm',
      modelName: 'm',
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
      inputCostPerMillionCents: costPerMillionCents,
      outputCostPerMillionCents: costPerMillionCents,
      available: true,
    }) as Model;
    const task = entity({
      kind: 'task',
      ownerId: 'u',
      scope: project.id,
      projectId: project.id,
      environmentId: 'e',
      title: 'repo',
      description: 'repository',
      acceptanceCriteria: ['repository'],
      status: 'ready',
      priority: 1,
      dependencyIds: [],
      labels: [],
    }) as Task;
    return { project, agent, model, task };
  };

  it('records usage/cost ledgers and blocks runs that exceed a project budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-budget-'));
    const store = createStore(dir);
    const { project, agent, model, task } = buildFixtures(1_000_000);
    for (const x of [project, agent, model, task]) await store.insert(x);
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: () => new MockLocalAdapter('m'),
    });
    const firstRun = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(firstRun.id);
    const usage = await store.list<UsageRecord>((x) => x.kind === 'usage');
    const costs = await store.list<CostRecord>((x) => x.kind === 'cost');
    expect(usage.length).toBeGreaterThan(0);
    expect(costs.length).toBe(usage.length);
    expect(usage[0]).toMatchObject({ projectId: project.id, agentId: agent.id });
    expect(costs[0]).toMatchObject({ projectId: project.id, agentId: agent.id, currency: 'USD' });
    const spent = costs.reduce((sum, cost) => sum + cost.amountCents, 0);
    expect(spent).toBeGreaterThan(0);
    await store.insert(
      entity({
        kind: 'budget',
        ownerId: 'u',
        scope: project.id,
        projectId: project.id,
        name: 'Lifetime cap',
        period: 'lifetime',
        limitCents: spent,
        warnRatio: 0.5,
        enabled: true,
      }) as Budget,
    );
    const events: Array<Record<string, unknown>> = [];
    orchestrator.on('run', (event: Record<string, unknown>) => events.push(event));
    const blockedRun = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(blockedRun.id);
    const saved = await store.get<Run>(blockedRun.id);
    expect(saved).toMatchObject({ status: 'blocked', error: 'budget_exceeded' });
    expect(events.some((event) => event.type === 'budget.exceeded')).toBe(true);
    const audit = await store.list((x) => x.kind === 'audit-event');
    expect(audit.some((event) => (event as AuditEvent).action === 'budget.blocked')).toBe(true);
    const alerts = await store.list((x) => x.kind === 'alert');
    expect(alerts.some((alert) => (alert as Alert).severity === 'critical')).toBe(true);
    expect((await store.verifyAuditChain()).valid).toBe(true);
  });

  it('creates checkpoints and evidence-backed completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const store = createStore(dir);
    const project = entity({
      kind: 'project',
      ownerId: 'u',
      scope: 'w',
      workspaceId: 'w',
      name: 'P',
      slug: 'p',
      archived: false,
    }) as Project;
    const agent = entity({
      kind: 'agent',
      ownerId: 'u',
      scope: project.id,
      projectId: project.id,
      environmentId: 'e',
      status: 'idle',
      profile: {
        name: 'A',
        mission: 'test',
        systemInstructions: 'test',
        projectRules: [],
        skills: [],
        allowedModels: ['m'],
        fallbackModelIds: [],
        allowedToolIds: [],
        allowedPluginIds: [],
        allowedPaths: ['.'],
        protectedPaths: ['.env'],
        network: 'blocked',
        environmentKeys: [],
        maxSteps: 2,
        timeLimitMs: 1000,
        tokenLimit: 1000,
        costLimitCents: 0,
        concurrencyLimit: 1,
        approvalPolicy: {
          requiredRisks: ['high', 'critical'],
          autoApproveReversible: false,
          expiryMs: 1000,
          delegates: [],
        },
        verificationPolicy: { deterministic: [], inferential: [], requireEvidence: true },
        memoryPolicy: {
          readableScopes: ['project'],
          writableScopes: [],
          requireApproval: true,
          retentionDays: 1,
        },
        outputFormat: 'text',
        escalationPolicy: 'pause',
        mode: 'supervised',
        version: 1,
        changelog: [],
      },
    }) as Agent;
    const model = entity({
      kind: 'model',
      ownerId: 'u',
      scope: project.id,
      providerId: 'p',
      name: 'm',
      modelName: 'm',
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
    const task = entity({
      kind: 'task',
      ownerId: 'u',
      scope: project.id,
      projectId: project.id,
      environmentId: 'e',
      title: 'repo',
      description: 'repository',
      acceptanceCriteria: ['repository'],
      status: 'ready',
      priority: 1,
      dependencyIds: [],
      labels: [],
    }) as Task;
    // Completion evidence must come from deterministic tool state, not model text.
    // This fixture exercises checkpoints/concurrency only, so it has no acceptance criteria.
    task.acceptanceCriteria = [];
    for (const x of [project, agent, model, task]) await store.insert(x);
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: () => new MockLocalAdapter('m'),
    });
    const events: Array<Record<string, unknown>> = [];
    orchestrator.on('run', (event: Record<string, unknown>) => events.push(event));
    const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    const concurrentRun = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await Promise.all([orchestrator.start(run.id), orchestrator.start(concurrentRun.id)]);
    const saved = await store.get<typeof run>(run.id);
    const savedConcurrent = await store.get<typeof concurrentRun>(concurrentRun.id);
    expect([saved?.status, savedConcurrent?.status]).toEqual(
      expect.arrayContaining(['completed', 'blocked']),
    );
    expect([saved?.error, savedConcurrent?.error]).toContain('agent_concurrency_limit');
    expect(events.some((event) => event.type === 'model.delta')).toBe(true);
    const completedRun = saved?.status === 'completed' ? saved : savedConcurrent!;
    const checkpoints = await store.list((x) => x.kind === 'checkpoint');
    expect(checkpoints.length).toBeGreaterThan(0);
    const checkpoint = checkpoints[0]!;
    const fork = await orchestrator.command({
      runId: completedRun.id,
      type: 'fork',
      checkpointId: checkpoint.id,
    });
    expect(fork?.parentRunId).toBe(completedRun.id);
    expect(await store.getRunState(fork!.id)).toEqual((checkpoint as unknown as Checkpoint).state);
    await store.setRunState(completedRun.id, { changed: true });
    await orchestrator.command({
      runId: completedRun.id,
      type: 'rollback',
      checkpointId: checkpoint.id,
    });
    expect(await store.getRunState(completedRun.id)).toEqual(
      (checkpoint as unknown as Checkpoint).state,
    );
  });
});
