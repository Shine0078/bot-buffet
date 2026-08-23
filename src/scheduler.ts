import type { JsonStateStore } from './store.js';
import type { Orchestrator } from './orchestrator.js';
import type { Agent, Project, Run, Schedule, Task } from './types.js';
import { dueSchedules } from './schedules.js';

export interface ScheduleTickResult {
  considered: number;
  due: number;
  started: number;
  skipped: number;
  errors: string[];
}

const ACTIVE = new Set(['queued', 'running', 'waiting_approval', 'paused', 'retrying']);

export async function tickSchedules(
  store: JsonStateStore,
  orchestrator: Orchestrator,
  at = new Date(),
): Promise<ScheduleTickResult> {
  const schedules = await store.list<Schedule>((value) => value.kind === 'schedule');
  const due = dueSchedules(schedules, at);
  const result: ScheduleTickResult = {
    considered: schedules.length,
    due: due.length,
    started: 0,
    skipped: 0,
    errors: [],
  };
  for (const schedule of due) {
    try {
      const task = await store.get<Task>(schedule.taskId);
      if (!task || task.kind !== 'task') throw new Error('schedule_task_missing');
      if (task.projectId !== schedule.projectId) throw new Error('schedule_project_mismatch');
      const project = await store.get<Project>(schedule.projectId);
      if (!project || project.kind !== 'project') throw new Error('schedule_project_missing');
      if (!task.assigneeAgentId) throw new Error('schedule_agent_required');
      const agent = await store.get<Agent>(task.assigneeAgentId);
      if (!agent || agent.kind !== 'agent') throw new Error('schedule_agent_missing');
      if (agent.projectId !== schedule.projectId)
        throw new Error('schedule_agent_project_mismatch');
      const runs = await store.list<Run>(
        (value) => value.kind === 'run' && (value as Run).taskId === task.id,
      );
      const minute = at.toISOString().slice(0, 16);
      const alreadyFired = runs.some((run) => run.createdAt.slice(0, 16) === minute);
      if (alreadyFired || runs.some((run) => ACTIVE.has(run.status))) {
        result.skipped += 1;
        continue;
      }
      const run = await orchestrator.createRun({
        ownerId: schedule.ownerId,
        project,
        agent,
        task,
      });
      await orchestrator.start(run.id);
      result.started += 1;
    } catch (error) {
      result.errors.push(`${schedule.id}:${(error as Error).message}`);
    }
  }
  return result;
}
