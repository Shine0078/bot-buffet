import { JsonStateStore } from './store.js';
import { randomUUID } from 'node:crypto';
import {
  Agent,
  Budget,
  Environment,
  Entity,
  Project,
  Schedule,
  Task,
  TaskDependency,
  Workflow,
  entity,
  now,
} from './types.js';

export interface DuplicateProjectResult {
  project: Project;
  copied: Record<string, number>;
  excluded: string[];
}

const remapIds = (value: unknown, ids: Map<string, string>): unknown => {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => remapIds(entry, ids));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      remapIds(entry, ids),
    ]),
  );
};

/**
 * Duplicate project configuration without copying execution state or secrets.
 * The caller must authorize the source project before invoking this function.
 */
export async function duplicateProject(
  store: JsonStateStore,
  source: Project,
  actorId: string,
  name?: string,
  slug?: string,
): Promise<DuplicateProjectResult> {
  const all = await store.list<Entity>(
    (value) =>
      value.scope === source.id ||
      (value as Entity & { projectId?: string }).projectId === source.id,
  );
  const environments = all.filter((value): value is Environment => value.kind === 'environment');
  const agents = all.filter((value): value is Agent => value.kind === 'agent');
  const tasks = all.filter((value): value is Task => value.kind === 'task');
  const dependencies = all.filter(
    (value): value is TaskDependency => value.kind === 'task-dependency',
  );
  const workflows = all.filter((value): value is Workflow => value.kind === 'workflow');
  const budgets = all.filter((value): value is Budget => value.kind === 'budget');
  const schedules = all.filter((value): value is Schedule => value.kind === 'schedule');

  const ids = new Map<string, string>();
  for (const value of [
    ...environments,
    ...agents,
    ...tasks,
    ...dependencies,
    ...workflows,
    ...budgets,
    ...schedules,
  ])
    ids.set(value.id, `${value.kind}_${randomUUID()}`);
  const copiedDefaultEnvironmentId =
    (source.defaultEnvironmentId ? ids.get(source.defaultEnvironmentId) : undefined) ??
    ids.get(environments[0]?.id ?? '');
  if (
    (environments.length > 0 || agents.length > 0 || tasks.length > 0) &&
    !copiedDefaultEnvironmentId
  )
    throw new Error('project_duplication_invalid_environment');
  const inserted: string[] = [];
  const lockResource = `project-duplicate:${source.workspaceId}`;
  const lockOwner = `duplicate_${randomUUID()}`;
  let locked = false;
  for (let attempt = 0; attempt < 40 && !locked; attempt += 1) {
    locked = await store.lock(lockResource, lockOwner, 120_000);
    if (!locked) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!locked) throw new Error('project_duplication_locked');
  let project: Project;
  try {
    const siblingSlugs = new Set(
      (
        await store.list<Project>(
          (value) =>
            value.kind === 'project' && (value as Project).workspaceId === source.workspaceId,
        )
      ).map((value) => (value as Project).slug),
    );
    const requestedSlug =
      String(slug ?? `${source.slug}-copy`)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || `${source.slug}-copy`;
    let uniqueSlug = requestedSlug;
    for (let suffix = 2; siblingSlugs.has(uniqueSlug) && suffix <= 1000; suffix += 1)
      uniqueSlug = `${requestedSlug.slice(0, 94)}-${suffix}`;
    if (siblingSlugs.has(uniqueSlug)) throw new Error('project_slug_unavailable');

    project = entity({
      kind: 'project',
      ownerId: actorId,
      scope: source.scope,
      workspaceId: source.workspaceId,
      name: String(name ?? `${source.name} copy`).slice(0, 200),
      slug: uniqueSlug,
      archived: false,
    }) as Project;
    if (copiedDefaultEnvironmentId) project.defaultEnvironmentId = copiedDefaultEnvironmentId;
    await store.insert(project);
    inserted.push(project.id);
  } finally {
    await store.unlock(lockResource, lockOwner);
  }
  const copy = async <T extends Entity>(value: T): Promise<void> => {
    await store.insert(value);
    inserted.push(value.id);
  };

  try {
    const environmentMap = new Map(
      environments.map((environment) => [environment.id, ids.get(environment.id)!]),
    );
    for (const environment of environments) {
      await copy({
        ...entity({
          kind: 'environment',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          name: environment.name,
          network: environment.network,
          persistent: environment.persistent,
          protected: environment.protected,
        }),
        id: environmentMap.get(environment.id),
      } as Environment);
    }
    const taskMap = new Map(tasks.map((task) => [task.id, ids.get(task.id)!]));
    const agentMap = new Map(agents.map((agent) => [agent.id, ids.get(agent.id)!]));
    for (const agent of agents) {
      await copy({
        ...entity({
          kind: 'agent',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          environmentId: environmentMap.get(agent.environmentId) ?? copiedDefaultEnvironmentId,
          status: 'idle',
          profile: {
            ...structuredClone(agent.profile),
            version: 1,
            changelog: [`Duplicated from ${source.id}`],
          },
        }),
        id: agentMap.get(agent.id),
      } as Agent);
    }
    for (const task of tasks) {
      await copy({
        ...entity({
          kind: 'task',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          environmentId: environmentMap.get(task.environmentId) ?? copiedDefaultEnvironmentId,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [...task.acceptanceCriteria],
          status: 'ready',
          priority: task.priority,
          assigneeAgentId: task.assigneeAgentId ? agentMap.get(task.assigneeAgentId) : undefined,
          parentTaskId: task.parentTaskId ? taskMap.get(task.parentTaskId) : undefined,
          dependencyIds: task.dependencyIds
            .map((dependencyId) => taskMap.get(dependencyId))
            .filter((dependencyId): dependencyId is string => Boolean(dependencyId)),
          labels: [...task.labels],
        }),
        id: taskMap.get(task.id),
      } as Task);
    }
    for (const dependency of dependencies) {
      const taskId = taskMap.get(dependency.taskId);
      const dependsOnTaskId = taskMap.get(dependency.dependsOnTaskId);
      if (!taskId || !dependsOnTaskId) continue;
      await copy({
        ...entity({
          kind: 'task-dependency',
          ownerId: actorId,
          scope: project.id,
          taskId,
          dependsOnTaskId,
          type: dependency.type,
        }),
        id: ids.get(dependency.id),
      } as TaskDependency);
    }
    for (const workflow of workflows) {
      await copy({
        ...entity({
          kind: 'workflow',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          name: workflow.name,
          description: workflow.description,
          nodes: remapIds(structuredClone(workflow.nodes), ids) as Workflow['nodes'],
          edges: structuredClone(workflow.edges),
          enabled: false,
        }),
        id: ids.get(workflow.id),
      } as Workflow);
    }
    for (const budget of budgets) {
      await copy({
        ...entity({
          kind: 'budget',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          agentId: budget.agentId ? agentMap.get(budget.agentId) : undefined,
          name: budget.name,
          period: budget.period,
          limitCents: budget.limitCents,
          warnRatio: budget.warnRatio,
          enabled: false,
        }),
        id: ids.get(budget.id),
      } as Budget);
    }
    for (const schedule of schedules) {
      const taskId = taskMap.get(schedule.taskId);
      if (!taskId) continue;
      await copy({
        ...entity({
          kind: 'schedule',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          cron: schedule.cron,
          taskId,
          enabled: false,
          timezone: schedule.timezone,
        }),
        id: ids.get(schedule.id),
      } as Schedule);
    }
  } catch (error) {
    for (const id of [...inserted].reverse()) await store.delete(id);
    throw error;
  }

  await store.audit({
    kind: 'audit-event',
    ownerId: actorId,
    scope: source.scope,
    actorId,
    action: 'project.duplicated',
    resourceType: 'project',
    resourceId: project.id,
    risk: 'medium',
    decision: 'executed',
    metadata: {
      sourceProjectId: source.id,
      copied: {
        environments: environments.length,
        agents: agents.length,
        tasks: tasks.length,
        dependencies: dependencies.length,
        workflows: workflows.length,
        budgets: budgets.length,
        schedules: schedules.length,
      },
      excluded: [
        'credentials',
        'providers',
        'models',
        'runs',
        'checkpoints',
        'files',
        'memory',
        'artifacts',
        'webhooks',
        'audit-events',
      ],
      at: now(),
    },
  });

  return {
    project,
    copied: {
      environments: environments.length,
      agents: agents.length,
      tasks: tasks.length,
      dependencies: dependencies.length,
      workflows: workflows.length,
      budgets: budgets.length,
      schedules: schedules.length,
    },
    excluded: [
      'credentials',
      'providers',
      'models',
      'runs',
      'checkpoints',
      'files',
      'memory',
      'artifacts',
      'webhooks',
      'audit-events',
    ],
  };
}
