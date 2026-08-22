import {
  entity,
  type Agent,
  type Model,
  type Project,
  type RunMode,
  type Task,
} from '../../src/types.js';

/**
 * Shared orchestrator fixtures.
 *
 * Not named `*.test.ts`, so vitest does not collect it as a suite. Several
 * suites need a complete project/agent/model/task graph, and duplicating it
 * meant a profile field could drift between them and quietly change what a
 * test was actually exercising.
 */
export function fixtures(mode: RunMode = 'execute') {
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
      // Every built-in tool is permitted, so a refusal in a test comes from
      // the behaviour under test rather than from the tool allowlist.
      allowedToolIds: ['fs.read', 'fs.write', 'shell.run'],
      allowedPluginIds: [],
      allowedPaths: ['.'],
      protectedPaths: ['.env'],
      network: 'blocked',
      environmentKeys: [],
      maxSteps: 2,
      timeLimitMs: 5000,
      tokenLimit: 4000,
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
        readableScopes: ['project', 'agent', 'task'],
        writableScopes: ['task'],
        requireApproval: false,
        retentionDays: 0,
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
