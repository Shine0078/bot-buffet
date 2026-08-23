import type { AgentStatus, Run, RunStatus } from './types.js';

/**
 * Agent presence.
 *
 * `Agent.status` carries a nine-value enum, and `currentRunId` / `currentTaskId`
 * sit beside it. Nothing ever wrote any of the three. An agent read as `idle`
 * while it was mid-run, while it was waiting on an approval nobody knew to give,
 * and after it had failed -- so the Office UI's central question, "what is this
 * desk doing right now", had no answer anywhere in the system, and an approval
 * could sit unnoticed indefinitely.
 *
 * Presence is derived from the agent's runs rather than assigned at each
 * lifecycle transition. Assignment has to be right at a dozen call sites and
 * stays right only until someone adds a thirteenth; derivation has one rule and
 * cannot drift out of step with the runs it describes. It is also the only
 * approach that survives concurrency: an agent may hold several runs at once,
 * and there is no single transition that knows what the others are doing.
 */

/** Run states that mean the agent is still holding this work. */
const LIVE: ReadonlySet<RunStatus> = new Set([
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'retrying',
  'blocked',
]);

/**
 * Which live run decides the agent's status, most operator-relevant first.
 *
 * `waiting_approval` outranks `running` deliberately. An agent running three
 * things where one needs a decision is, from the operator's side, an agent that
 * needs a decision -- surfacing `working` would bury the only state that
 * requires a person, which is the failure this whole field exists to prevent.
 */
const PRIORITY: readonly RunStatus[] = [
  'waiting_approval',
  'blocked',
  'retrying',
  'running',
  'paused',
  'queued',
];

const LIVE_STATUS: Partial<Record<RunStatus, AgentStatus>> = {
  waiting_approval: 'waiting_approval',
  blocked: 'blocked',
  retrying: 'retrying',
  running: 'working',
  paused: 'paused',
  queued: 'working',
};

export interface Presence {
  status: AgentStatus;
  currentRunId?: string;
  currentTaskId?: string;
}

const IDLE: Presence = { status: 'idle', currentRunId: undefined, currentTaskId: undefined };

/**
 * Derive an agent's presence from its runs.
 *
 * When nothing is live, the most recent finished run decides: a failure is
 * reported as `failed` rather than folded into `idle`, so a desk that stopped
 * badly stays visibly different from one that simply has no work. It clears as
 * soon as the agent starts something new, which is the point at which the
 * failure is no longer the most useful thing to say about it.
 *
 * `completed` is deliberately not used for an agent. It describes a run, not a
 * desk, and an agent that finished successfully is available -- reporting it as
 * `completed` would make an idle agent look like one that had retired.
 */
export function derivePresence(runs: readonly Run[]): Presence {
  const live = runs.filter((run) => LIVE.has(run.status));
  for (const status of PRIORITY) {
    const match = live.find((run) => run.status === status);
    if (!match) continue;
    return {
      status: LIVE_STATUS[status] ?? 'working',
      currentRunId: match.id,
      currentTaskId: match.taskId,
    };
  }

  const finished = runs.filter((run) => !LIVE.has(run.status));
  if (!finished.length) return IDLE;
  const latest = finished.reduce((newest, run) =>
    Date.parse(run.updatedAt) >= Date.parse(newest.updatedAt) ? run : newest,
  );
  return latest.status === 'failed' ? { status: 'failed' } : IDLE;
}
