import type { JsonStateStore } from './store.js';
import type { Agent, Project, Run, Schedule, Task } from './types.js';

/**
 * A deliberately small, dependency-free cron matcher for the five-field
 * expression Bot Buffet persists. The parser is bounded and rejects every
 * construct it cannot evaluate, so a schedule can never silently run at an
 * unexpected time. The supported grammar is `*`, star-slash steps, comma lists, ranges,
 * and ranged steps (for example `1-5/2`).
 */
const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

type CronFields = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

function parseField(raw: string, minimum: number, maximum: number): Set<number> {
  if (!raw || raw.length > 32) throw new Error('schedule_cron_invalid');
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part || part.length > 16) throw new Error('schedule_cron_invalid');
    const segments = part.split('/');
    if (segments.length > 2) throw new Error('schedule_cron_invalid');
    const rangePart = segments[0]!;
    const stepPart = segments[1];
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1)
      throw new Error('schedule_cron_invalid');
    let start = minimum;
    let end = maximum;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      if (bounds.length > 2) throw new Error('schedule_cron_invalid');
      start = Number(bounds[0]);
      end = bounds.length === 2 ? Number(bounds[1]) : start;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < minimum ||
        end > maximum ||
        start > end
      )
        throw new Error('schedule_cron_invalid');
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error('schedule_cron_invalid');
  return values;
}

export function parseCronExpression(expression: string): CronFields {
  if (expression.length > 128) throw new Error('schedule_cron_invalid');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('schedule_cron_invalid');
  return fields.map((field, index) => {
    const [minimum, maximum] = FIELD_RANGES[index]!;
    return parseField(field, minimum, maximum);
  }) as CronFields;
}

export function assertScheduleTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
  } catch {
    throw new Error('schedule_timezone_invalid');
  }
}

function localDateParts(date: Date, timeZone: string): [number, number, number, number, number] {
  assertScheduleTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
  return [
    Number(value('minute')),
    Number(value('hour')),
    Number(value('day')),
    Number(value('month')),
    weekday,
  ];
}

export function cronMatches(expression: string, date: Date, timeZone = 'UTC'): boolean {
  const fields = parseCronExpression(expression);
  const values = localDateParts(date, timeZone);
  const matches = fields.map((field, index) => field.has(values[index]!));
  // POSIX cron treats day-of-month and day-of-week as an OR when both are
  // restricted. This is the least surprising behaviour for recurring tasks.
  const dayOfMonthRestricted = fields[2]!.size < 31;
  const dayOfWeekRestricted = fields[4]!.size < 7;
  const dayMatches =
    dayOfMonthRestricted && dayOfWeekRestricted
      ? matches[2] || matches[4]
      : matches[2] && matches[4];
  return Boolean(matches[0] && matches[1] && dayMatches && matches[3]);
}

export interface ScheduleRunStarter {
  createRun(input: { ownerId: string; project: Project; agent: Agent; task: Task }): Promise<Run>;
  start(runId: string): Promise<void>;
}

export interface ScheduleTickResult {
  checked: number;
  triggered: number;
  skipped: number;
  errors: number;
}

export interface ScheduleDispatcherDeps {
  store: JsonStateStore;
  orchestrator: ScheduleRunStarter;
}

/**
 * Durable, single-process schedule dispatcher. Every trigger is claimed with
 * compare-and-swap before a run is created. That makes two workers safe to run
 * during a rolling deployment: only one can win a schedule's minute claim.
 */
export class ScheduleDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly deps: ScheduleDispatcherDeps,
    private readonly intervalMs = 15_000,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(date = this.clock()): Promise<ScheduleTickResult> {
    if (this.ticking) return { checked: 0, triggered: 0, skipped: 0, errors: 0 };
    this.ticking = true;
    const result: ScheduleTickResult = { checked: 0, triggered: 0, skipped: 0, errors: 0 };
    try {
      const schedules = await this.deps.store.list<Schedule>(
        (value) => value.kind === 'schedule' && value.enabled,
      );
      for (const schedule of schedules) {
        result.checked += 1;
        let due = false;
        try {
          due = cronMatches(schedule.cron, date, schedule.timezone);
        } catch (error) {
          result.errors += 1;
          await this.recordScheduleError(
            schedule,
            error instanceof Error ? error.message : 'schedule_invalid',
          );
          continue;
        }
        if (!due || this.alreadyClaimedThisMinute(schedule, date)) {
          result.skipped += 1;
          continue;
        }
        const claimedAt = date.toISOString();
        let claimed: Schedule;
        try {
          claimed = await this.deps.store.putIfVersion(
            { ...schedule, lastTriggeredAt: claimedAt, lastError: undefined },
            schedule.version,
          );
        } catch {
          // Another worker won the compare-and-swap claim.
          result.skipped += 1;
          continue;
        }
        const task = await this.deps.store.get<Task>(claimed.taskId);
        const project = await this.deps.store.get<Project>(claimed.projectId);
        const agent = task?.assigneeAgentId
          ? await this.deps.store.get<Agent>(task.assigneeAgentId)
          : undefined;
        if (
          !task ||
          !project ||
          !agent ||
          task.projectId !== project.id ||
          agent.projectId !== project.id ||
          task.environmentId !== agent.environmentId
        ) {
          result.errors += 1;
          await this.recordScheduleError(claimed, 'schedule_context_invalid');
          continue;
        }
        try {
          const run = await this.deps.orchestrator.createRun({
            ownerId: claimed.ownerId,
            project,
            agent,
            task,
          });
          await this.deps.store.putIfVersion(
            { ...claimed, lastRunId: run.id, lastError: undefined },
            claimed.version,
          );
          await this.deps.store.audit({
            kind: 'audit-event',
            ownerId: claimed.ownerId,
            scope: claimed.scope,
            actorId: claimed.ownerId,
            action: 'schedule.triggered',
            resourceType: 'schedule',
            resourceId: claimed.id,
            risk: 'medium',
            decision: 'executed',
            metadata: { runId: run.id, taskId: task.id },
          });
          result.triggered += 1;
          void this.deps.orchestrator.start(run.id).catch(async (error: unknown) => {
            await this.recordScheduleError(
              claimed,
              error instanceof Error ? error.message : 'run_start_failed',
            );
          });
        } catch (error) {
          result.errors += 1;
          await this.recordScheduleError(
            claimed,
            error instanceof Error ? error.message : 'schedule_run_failed',
          );
        }
      }
    } finally {
      this.ticking = false;
    }
    return result;
  }

  private alreadyClaimedThisMinute(schedule: Schedule, date: Date): boolean {
    if (!schedule.lastTriggeredAt) return false;
    const claimed = Date.parse(schedule.lastTriggeredAt);
    return (
      Number.isFinite(claimed) &&
      Math.floor(claimed / 60_000) === Math.floor(date.getTime() / 60_000)
    );
  }

  private async recordScheduleError(schedule: Schedule, error: string): Promise<void> {
    try {
      const current = await this.deps.store.get<Schedule>(schedule.id);
      if (current) {
        const boundedError = error.slice(0, 256);
        if (current.lastError === boundedError) return;
        const saved = await this.deps.store.putIfVersion(
          { ...current, lastError: boundedError },
          current.version,
        );
        await this.deps.store.audit({
          kind: 'audit-event',
          ownerId: saved.ownerId,
          scope: saved.scope,
          actorId: saved.ownerId,
          action: 'schedule.error',
          resourceType: 'schedule',
          resourceId: saved.id,
          risk: 'medium',
          decision: 'denied',
          metadata: { error: saved.lastError },
        });
      }
    } catch {
      // Schedule errors must not stop the dispatcher or hide the original error.
    }
  }
}
