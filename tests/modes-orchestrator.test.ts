import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLocalAdapter } from '../src/providers.js';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import {
  entity,
  type Agent,
  type AuditEvent,
  type Model,
  type Project,
  type Run,
  type RunMode,
  type Task,
} from '../src/types.js';

/**
 * Wiring evidence for run modes. The unit suite proves the decision function;
 * this proves the orchestrator actually consults it, which is the part that
 * was missing when the mode was declared but never read.
 */

function fixtures(mode: RunMode) {
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
      // Every built-in tool is permitted, so any refusal below comes from the
      // mode rather than from the profile's tool allowlist.
      allowedToolIds: ['fs.read', 'fs.write', 'shell.run'],
      allowedPluginIds: [],
      allowedPaths: ['.'],
      protectedPaths: ['.env'],
      network: 'blocked',
      environmentKeys: [],
      maxSteps: 2,
      timeLimitMs: 5000,
      tokenLimit: 1000,
      costLimitCents: 0,
      concurrencyLimit: 1,
      approvalPolicy: {
        requiredRisks: ['critical'],
        autoApproveReversible: false,
        expiryMs: 1000,
        delegates: [],
      },
      verificationPolicy: { deterministic: [], inferential: [], requireEvidence: false },
      memoryPolicy: {
        readableScopes: ['project'],
        writableScopes: [],
        requireApproval: true,
        retentionDays: 1,
      },
      outputFormat: 'text',
      escalationPolicy: 'pause',
      mode,
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
  return { project, agent, model, task };
}

async function runInMode(mode: RunMode) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-mode-'));
  await writeFile(join(dir, 'repository'), 'contents');
  const store = createStore(dir);
  const { project, agent, model, task } = fixtures(mode);
  for (const record of [project, agent, model, task]) await store.insert(record);
  const orchestrator = new Orchestrator({
    store,
    router: new ModelRouter(async () => [model]),
    tools: createBuiltinTools(store),
    workspaceRoot: () => dir,
    adapters: () => new MockLocalAdapter('m'),
  });
  const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
  await orchestrator.start(run.id);
  const finished = await store.get<Run>(run.id);
  const audit = await store.list<AuditEvent>((x) => x.kind === 'audit-event');
  return { store, run: finished, audit };
}

describe('run modes are enforced by the orchestrator', () => {
  it('halts an emergency-stop run without executing a single step', async () => {
    const { run, audit } = await runInMode('emergency-stop');
    expect(run?.status).toBe('blocked');
    expect(run?.error).toBe('mode_run_halted');
    expect(run?.stepCount).toBe(0);
    expect(audit.some((event) => event.action === 'run.mode_halted')).toBe(true);
  });

  it('lets a supervised run start, which is the control for the test above', async () => {
    const { run } = await runInMode('supervised');
    // Anything other than "blocked by the mode" proves the halt was specific.
    expect(run?.error).not.toBe('mode_run_halted');
  });

  it('keeps the audit chain verifiable after a mode refusal', async () => {
    const { store } = await runInMode('emergency-stop');
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });

  it('records the mode on the run so a refusal can be explained afterwards', async () => {
    const { run } = await runInMode('emergency-stop');
    expect(run?.mode).toBe('emergency-stop');
  });
});
