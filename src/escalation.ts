/**
 * What an escalation policy means when a run fails.
 *
 * `escalationPolicy` was validated when a profile was written and never read,
 * so every failure ended the run regardless of what the operator chose.
 *
 * `pause` is the only outcome that leaves the run resumable, and it is
 * deliberately not stamped as finished: the checkpoint is intact and a human
 * decides what happens next. `retry` also pauses rather than looping
 * immediately — the step-level model retry with backoff has already been
 * exhausted by this point, so retrying the whole run without a human looking
 * would be a loop rather than a recovery. `delegate` blocks the run so it can
 * be reassigned to another agent, which is a decision the harness does not
 * make on its own. `stop` fails it outright.
 */
export type EscalationPolicy = 'pause' | 'retry' | 'delegate' | 'stop';

export interface EscalationOutcome {
  status: 'paused' | 'blocked' | 'failed';
  reason: string;
}

export function escalationOutcome(policy: EscalationPolicy): EscalationOutcome {
  switch (policy) {
    case 'pause':
      return { status: 'paused', reason: 'Paused for a human decision; the checkpoint is intact.' };
    case 'retry':
      return {
        status: 'paused',
        reason:
          'Model-level retries were already exhausted, so the run is paused for a human rather than looped.',
      };
    case 'delegate':
      return {
        status: 'blocked',
        reason: 'Blocked for reassignment to another agent or model.',
      };
    case 'stop':
      return { status: 'failed', reason: 'Stopped on failure by policy.' };
    default:
      // An unrecognised policy fails the run rather than leaving it running.
      return { status: 'failed', reason: 'Unrecognised escalation policy; failing closed.' };
  }
}
