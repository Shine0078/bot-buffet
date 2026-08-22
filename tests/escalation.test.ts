import { describe, expect, it } from 'vitest';
import { escalationOutcome, type EscalationPolicy } from '../src/escalation.js';

describe('escalation policy', () => {
  /**
   * `escalationPolicy` was validated when a profile was written and never
   * read, so every failure ended the run regardless of what the operator
   * chose.
   */
  it('pauses for a human and leaves the run resumable', () => {
    const outcome = escalationOutcome('pause');
    expect(outcome.status).toBe('paused');
    expect(outcome.reason).toMatch(/checkpoint is intact/i);
  });

  it('pauses on retry rather than looping the whole run', () => {
    // Step-level model retries with backoff are already exhausted by this
    // point, so retrying the run unattended would be a loop, not a recovery.
    const outcome = escalationOutcome('retry');
    expect(outcome.status).toBe('paused');
    expect(outcome.reason).toMatch(/already exhausted/i);
  });

  it('blocks on delegate, because reassignment is a human decision', () => {
    expect(escalationOutcome('delegate').status).toBe('blocked');
  });

  it('fails on stop', () => {
    expect(escalationOutcome('stop').status).toBe('failed');
  });

  it('fails closed on an unrecognised policy', () => {
    expect(escalationOutcome('nonsense' as EscalationPolicy).status).toBe('failed');
  });

  it('gives every outcome a reason an operator can act on', () => {
    for (const policy of ['pause', 'retry', 'delegate', 'stop'] as const) {
      expect(escalationOutcome(policy).reason.length, policy).toBeGreaterThan(15);
    }
  });

  it('only pause-like policies leave the run resumable', () => {
    const resumable = (['pause', 'retry', 'delegate', 'stop'] as const).filter(
      (policy) => escalationOutcome(policy).status === 'paused',
    );
    expect(resumable).toEqual(['pause', 'retry']);
  });
});
