import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScheduleDispatcher, cronMatches, parseCronExpression } from '../src/scheduler.js';
import { createStore } from '../src/store.js';
import {
  entity,
  type Agent,
  type Project,
  type Run,
  type Schedule,
  type Task,
} from '../src/types.js';

const project = entity({
  kind: 'project',
  ownerId: 'owner-1',
  scope: 'workspace-1',
  workspaceId: 'workspace-1',
  name: 'Scheduler project',
  slug: 'scheduler-project',
  archived: false,
}) as Project;
const agent = entity({
  kind: 'agent',
  ownerId: 'owner-1',
  scope: project.id,
  projectId: project.id,
  environmentId: 'environment-1',
  status: 'idle',
  profile: {} as Agent['profile'],
}) as Agent;
const task = entity({
  kind: 'task',
  ownerId: 'owner-1',
  scope: project.id,
  projectId: project.id,
  environmentId: 'environment-1',
  title: 'Scheduled task',
  description: 'Run on the clock',
  acceptanceCriteria: [],
  status: 'ready',
  priority: 1,
  assigneeAgentId: agent.id,
  dependencyIds: [],
  labels: [],
}) as Task;

const scheduleAt = (cron: string): Schedule =>
  entity({
    kind: 'schedule',
    ownerId: 'owner-1',
    scope: project.id,
    projectId: project.id,
    cron,
    taskId: task.id,
    enabled: true,
    timezone: 'UTC',
  }) as Schedule;

describe('bounded cron schedules', () => {
  it('matches lists, ranges, steps, and rejects unsupported expressions', () => {
    const date = new Date('2026-08-22T12:34:00.000Z');
    expect(cronMatches('34 12 * * *', date)).toBe(true);
    expect(cronMatches('*/15 12 * * 6', date)).toBe(false);
    expect(cronMatches('30-40 12 * * 6', date)).toBe(true);
    expect(() => parseCronExpression('* * *')).toThrow('schedule_cron_invalid');
    expect(() => parseCronExpression('0 0 1 1 1 2026')).toThrow('schedule_cron_invalid');
  });

  it('evaluates the expression in the configured timezone', () => {
    const utc = new Date('2026-08-22T12:34:00.000Z');
    expect(cronMatches('34 12 * * *', utc, 'UTC')).toBe(true);
    expect(cronMatches('34 08 * * *', utc, 'America/Toronto')).toBe(true);
  });
});

describe('durable schedule dispatch', () => {
  it('claims a matching minute once and starts the assigned task', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'bot-buffet-scheduler-')));
    await store.insert(project);
    await store.insert(agent);
    await store.insert(task);
    const schedule = scheduleAt('34 12 * * *');
    await store.insert(schedule);
    const started: string[] = [];
    const dispatcher = new ScheduleDispatcher(
      {
        store,
        orchestrator: {
          async createRun() {
            return { id: 'run-scheduled-1' } as Run;
          },
          async start(runId) {
            started.push(runId);
          },
        },
      },
      60_000,
    );
    const first = await dispatcher.tick(new Date('2026-08-22T12:34:00.000Z'));
    const second = await dispatcher.tick(new Date('2026-08-22T12:34:20.000Z'));
    expect(first).toMatchObject({ checked: 1, triggered: 1, errors: 0 });
    expect(second).toMatchObject({ checked: 1, triggered: 0 });
    expect(started).toEqual(['run-scheduled-1']);
    expect((await store.get<Schedule>(schedule.id))?.lastRunId).toBe('run-scheduled-1');
  });

  it('uses CAS so concurrent workers cannot trigger the same minute twice', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'bot-buffet-scheduler-race-')));
    await store.insert(project);
    await store.insert(agent);
    await store.insert(task);
    await store.insert(scheduleAt('* * * * *'));
    let createCount = 0;
    const deps = {
      store,
      orchestrator: {
        async createRun() {
          createCount += 1;
          return { id: `run-${createCount}` } as Run;
        },
        async start() {},
      },
    };
    const date = new Date('2026-08-22T12:34:00.000Z');
    const [left, right] = await Promise.all([
      new ScheduleDispatcher(deps).tick(date),
      new ScheduleDispatcher(deps).tick(date),
    ]);
    expect(left.triggered + right.triggered).toBe(1);
    expect(createCount).toBe(1);
  });

  it('records a bounded error instead of creating an unassigned run', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'bot-buffet-scheduler-error-')));
    await store.insert(project);
    await store.insert({ ...task, assigneeAgentId: undefined });
    const schedule = scheduleAt('* * * * *');
    await store.insert(schedule);
    const dispatcher = new ScheduleDispatcher({
      store,
      orchestrator: {
        async createRun() {
          throw new Error('must not run');
        },
        async start() {},
      },
    });
    const result = await dispatcher.tick(new Date('2026-08-22T12:34:00.000Z'));
    expect(result.errors).toBe(1);
    expect((await store.get<Schedule>(schedule.id))?.lastError).toBe('schedule_context_invalid');
  });
});
