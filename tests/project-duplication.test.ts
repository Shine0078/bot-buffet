import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplicateProject } from '../src/projectDuplication.js';
import { createStore } from '../src/store.js';
import {
  entity,
  type Agent,
  type Environment,
  type Project,
  type Task,
  type Workflow,
} from '../src/types.js';

describe('safe project duplication', () => {
  it('copies configuration with remapped IDs and excludes live state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const store = createStore(dir);
    const source = entity({
      kind: 'project',
      ownerId: 'u',
      scope: 'workspace',
      workspaceId: 'workspace',
      name: 'Source',
      slug: 'source',
      archived: false,
    }) as Project;
    const environment = entity({
      kind: 'environment',
      ownerId: 'u',
      scope: source.id,
      projectId: source.id,
      name: 'Safe',
      network: 'blocked' as const,
      persistent: true,
      protected: false,
    }) as Environment;
    const agent = entity({
      kind: 'agent',
      ownerId: 'u',
      scope: source.id,
      projectId: source.id,
      environmentId: environment.id,
      status: 'working' as const,
      currentRunId: 'run_live',
      profile: {
        name: 'Builder',
        mission: 'build',
        systemInstructions: 'safe',
        projectRules: [],
        skills: [],
        allowedModels: [],
        fallbackModelIds: [],
        allowedToolIds: [],
        allowedPluginIds: [],
        allowedPaths: ['.'],
        protectedPaths: ['.env'],
        network: 'blocked' as const,
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
        outputFormat: 'text' as const,
        escalationPolicy: 'pause' as const,
        mode: 'supervised' as const,
        version: 1,
        changelog: [],
      },
    }) as Agent;
    const task = entity({
      kind: 'task',
      ownerId: 'u',
      scope: source.id,
      projectId: source.id,
      environmentId: environment.id,
      title: 'Task',
      description: 'Do it',
      acceptanceCriteria: ['done'],
      status: 'done' as const,
      priority: 1,
      assigneeAgentId: agent.id,
      dependencyIds: [],
      labels: ['copy'],
    }) as Task;
    const workflow = entity({
      kind: 'workflow',
      ownerId: 'u',
      scope: source.id,
      projectId: source.id,
      name: 'Flow',
      description: 'flow',
      nodes: [{ id: 'n1', kind: 'task' as const, config: { taskId: task.id } }],
      edges: [],
      enabled: true,
    }) as Workflow;
    for (const value of [source, environment, agent, task, workflow]) await store.insert(value);

    const result = await duplicateProject(store, source, 'u', 'Copy', 'copy');
    expect(result.project.id).not.toBe(source.id);
    expect(result.project.name).toBe('Copy');
    expect(result.copied).toMatchObject({ environments: 1, agents: 1, tasks: 1, workflows: 1 });
    expect(result.excluded).toContain('credentials');

    const copiedAgents = await store.list<Agent>(
      (value) => value.kind === 'agent' && value.projectId === result.project.id,
    );
    const copiedTasks = await store.list<Task>(
      (value) => value.kind === 'task' && value.projectId === result.project.id,
    );
    const copiedWorkflows = await store.list<Workflow>(
      (value) => value.kind === 'workflow' && value.projectId === result.project.id,
    );
    expect(copiedAgents[0]?.id).not.toBe(agent.id);
    expect(copiedAgents[0]?.status).toBe('idle');
    expect(copiedAgents[0]?.currentRunId).toBeUndefined();
    expect(copiedTasks[0]?.status).toBe('ready');
    expect(copiedTasks[0]?.assigneeAgentId).toBe(copiedAgents[0]?.id);
    expect(copiedWorkflows[0]?.enabled).toBe(false);
    expect(copiedWorkflows[0]?.nodes[0]?.config.taskId).toBe(copiedTasks[0]?.id);

    const [parallelA, parallelB] = await Promise.all([
      duplicateProject(store, source, 'u', 'Parallel A', 'parallel'),
      duplicateProject(store, source, 'u', 'Parallel B', 'parallel'),
    ]);
    expect(new Set([parallelA.project.slug, parallelB.project.slug])).toEqual(
      new Set(['parallel', 'parallel-2']),
    );
  });
});
