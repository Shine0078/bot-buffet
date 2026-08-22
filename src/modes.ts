import type { Risk, RunMode } from './types.js';

/**
 * Run mode semantics.
 *
 * `RunMode` was declared on every agent profile and stored on every run, but
 * nothing read it: a run in `plan` mode could mutate files exactly like one in
 * `autonomous`, and `emergency-stop` did nothing at all. A mode that does not
 * constrain anything is worse than no mode, because the interface promises a
 * safety property the runtime does not provide.
 *
 * Each mode is expressed as a constraint the harness applies *in addition to*
 * the agent's policy — never instead of it. A mode can only narrow what the
 * policy already permits, so selecting a mode can never be an escalation.
 */

const RISK_RANK: Record<Risk, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

export interface ModeConstraints {
  /** Whether a run in this mode may start or continue at all. */
  canRun: boolean;
  /** Whether the model may call tools. */
  toolsAllowed: boolean;
  /**
   * The highest risk a tool may carry in this mode. A tool above it is refused
   * outright rather than escalated to approval: the mode says this kind of work
   * is not what the run is for.
   */
  maxToolRisk: Risk;
  /**
   * Anything strictly above this risk needs human approval, whatever the
   * policy says. `safe` means every non-read action is approved by a human.
   */
  approvalAbove: Risk;
  /** Human-readable reason, used in refusals and audit records. */
  description: string;
}

const CONSTRAINTS: Record<RunMode, ModeConstraints> = {
  // Planning reads and reasons; it does not change anything. Producing a plan
  // that also edited the repository would defeat the point of reviewing it.
  plan: {
    canRun: true,
    toolsAllowed: true,
    maxToolRisk: 'safe',
    approvalAbove: 'safe',
    description: 'Planning is read-only: only safe tools may run.',
  },
  // Review inspects work that already exists, under the same read-only rule.
  review: {
    canRun: true,
    toolsAllowed: true,
    maxToolRisk: 'safe',
    approvalAbove: 'safe',
    description: 'Review is read-only: only safe tools may run.',
  },
  // Conversation only. No tool may run, so nothing outside the transcript moves.
  chat: {
    canRun: true,
    toolsAllowed: false,
    maxToolRisk: 'safe',
    approvalAbove: 'safe',
    description: 'Chat runs no tools.',
  },
  // Ordinary work. High and critical actions still require approval.
  execute: {
    canRun: true,
    toolsAllowed: true,
    maxToolRisk: 'critical',
    approvalAbove: 'medium',
    description: 'Execution may use any permitted tool; high risk needs approval.',
  },
  // A human is watching, so anything that is not a read gets confirmed.
  supervised: {
    canRun: true,
    toolsAllowed: true,
    maxToolRisk: 'critical',
    approvalAbove: 'safe',
    description: 'Supervised mode approves every action that is not read-only.',
  },
  // Unattended. Deliberately capped below critical: nobody is present to
  // approve an irreversible action, so the mode must not be able to reach one.
  autonomous: {
    canRun: true,
    toolsAllowed: true,
    maxToolRisk: 'high',
    approvalAbove: 'medium',
    description: 'Autonomous mode cannot take critical actions with nobody watching.',
  },
  // Routine upkeep: small, reversible changes only.
  maintenance: {
    canRun: true,
    toolsAllowed: true,
    maxToolRisk: 'low',
    approvalAbove: 'low',
    description: 'Maintenance is limited to low-risk, reversible work.',
  },
  // The stop switch. Nothing runs, and the mode itself is the reason.
  'emergency-stop': {
    canRun: false,
    toolsAllowed: false,
    maxToolRisk: 'safe',
    approvalAbove: 'safe',
    description: 'Emergency stop: this run may not execute.',
  },
  // A user-defined mode carries no implicit relaxation. It defers to policy
  // for approvals but still refuses critical actions, so defining a custom
  // mode can never be a way around the built-in ceilings.
  custom: {
    canRun: true,
    toolsAllowed: true,
    maxToolRisk: 'high',
    approvalAbove: 'medium',
    description: 'Custom mode defers to policy but cannot reach critical actions.',
  },
};

export function modeConstraints(mode: RunMode): ModeConstraints {
  const constraints = CONSTRAINTS[mode];
  // An unrecognised mode is treated as the most restrictive one rather than
  // waved through, so a future mode added to the type but not to this table
  // fails closed.
  return constraints ?? CONSTRAINTS['emergency-stop'];
}

export type ModeDecision =
  | { allowed: true; requiresApproval: boolean }
  | { allowed: false; reason: string; code: ModeRefusal };

export type ModeRefusal = 'mode_run_halted' | 'mode_tools_disabled' | 'mode_risk_exceeded';

/**
 * Decide whether a tool call is permitted by the run's mode.
 *
 * This runs alongside the policy check, not instead of it: `requiresApproval`
 * being false here never means the policy's own approval requirement is
 * skipped. The caller combines both.
 */
export function decideMode(mode: RunMode, toolRisk: Risk): ModeDecision {
  const constraints = modeConstraints(mode);

  if (!constraints.canRun) {
    return { allowed: false, reason: constraints.description, code: 'mode_run_halted' };
  }
  if (!constraints.toolsAllowed) {
    return { allowed: false, reason: constraints.description, code: 'mode_tools_disabled' };
  }
  if (RISK_RANK[toolRisk] > RISK_RANK[constraints.maxToolRisk]) {
    return {
      allowed: false,
      reason: `${constraints.description} A ${toolRisk}-risk tool exceeds the ${mode} ceiling of ${constraints.maxToolRisk}.`,
      code: 'mode_risk_exceeded',
    };
  }
  return {
    allowed: true,
    requiresApproval: RISK_RANK[toolRisk] > RISK_RANK[constraints.approvalAbove],
  };
}

/** Whether a run in this mode may start at all. */
export function canStartInMode(mode: RunMode): boolean {
  return modeConstraints(mode).canRun;
}

export const ALL_RUN_MODES = Object.keys(CONSTRAINTS) as RunMode[];
