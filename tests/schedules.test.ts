import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cronMatches, dueSchedules, parseCron } from '../src/schedules.js';
import { tickSchedules } from '../src/scheduler.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ModelRouter } from '../src/router.js';
import { createBuiltinTools } from '../src/tools.js';
import { MockLocalAdapter } from '../src/providers.js';
import { entity, type Run, type Schedule } from '../src/types.js';

describe('cron matching', () => {
  it('accepts a five-field expression and rejects junk', () => {
    expect(parseCron('0 * * * *')).toEqual(['0', '*', '*', '*', '*']);
    expect(() => parseCron('* * *')).toThrow(/schedule_cron_invalid/);
    expect(() => parseCron('60 * * * *')).toThrow(/schedule_cron_invalid/);
  });

  it('matches UTC time without inventing a full cron language', () => {
    const noon = new Date(Date.UTC(2026, 7, 23, 12, 0, 0));
    expect(cronMatches('0 12 * * *', noon)).toBe(true);
    expect(cronMatches('1 12 * * *', noon)).toBe(false);
    expect(cronMatches('*/15 * * * *', new Date(Date.UTC(2026, 7, 23, 12, 30, 0)))).toBe(true);
  });

  it('matches cron fields in the stored IANA timezone, not silently in UTC', () => {
    const utcNoon = new Date(Date.UTC(2026, 7, 23, 12, 0, 0));
    expect(cronMatches('0 8 * * *', utcNoon, 'America/Toronto')).toBe(true);
    expect(cronMatches('0 12 * * *', utcNoon, 'America/Toronto')).toBe(false);
    expect(() => cronMatches('0 12 * * *', utcNoon, 'Not/AZone')).toThrow(
      /schedule_timezone_invalid/,
    );
  });

  it('ignores disabled schedules even when the expression matches', () => {
    const noon = new Date(Date.UTC(2026, 7, 23, 12, 0, 0));
    const enabled = entity({
      kind: 'schedule',
      ownerId: 'u',
      scope: 'p',
      projectId: 'p',
      cron: '0 12 * * *',
      taskId: 't',
      enabled: true,
      timezone: 'UTC',
    }) as Schedule;
    const disabled = { ...enabled, id: 's2', enabled: false } as Schedule;
    expect(dueSchedules([enabled, disabled], noon).map((item) => item.id)).toEqual([enabled.id]);
  });
});

describe('schedule ticks', () => {
  it('starts a run for a due assigned task and skips an already-active one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-sched-'));
    const store = createStore(dir);
    const { project, agent, model, task } = fixtures('supervised');
    task.assigneeAgentId = agent.id;
    const schedule = entity({
      kind: 'schedule',
      ownerId: 'u',
      scope: project.id,
      projectId: project.id,
      cron: '* * * * *',
      taskId: task.id,
      enabled: true,
      timezone: 'UTC',
    }) as Schedule;
    for (const record of [project, agent, model, task, schedule]) await store.insert(record);
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: () => new MockLocalAdapter('m'),
    });
    const first = await tickSchedules(store, orchestrator, new Date());
    expect(first.started).toBe(1);
    const runs = await store.list<Run>((value) => value.kind === 'run');
    expect(runs).toHaveLength(1);
    const second = await tickSchedules(store, orchestrator, new Date());
    expect(second.skipped).toBe(1);
    expect(await store.list<Run>((value) => value.kind === 'run')).toHaveLength(1);
  });
});
