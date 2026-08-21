import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLocalAdapter } from '../src/providers.js';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { Agent, Model, Project, Task, entity } from '../src/types.js';

describe('durable orchestration', () => {
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
    for (const x of [project, agent, model, task]) await store.insert(x);
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: () => new MockLocalAdapter('m'),
    });
    const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(run.id);
    const saved = await store.get<typeof run>(run.id);
    expect(saved?.status).toBe('completed');
    expect((await store.list((x) => x.kind === 'checkpoint')).length).toBeGreaterThan(0);
  });
});
