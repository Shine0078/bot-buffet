import { describe, expect, it } from 'vitest';
import { requiresApproval } from '../src/approval.js';
import type { Risk } from '../src/types.js';

describe('approval decision combines its three sources', () => {
  const base = {
    policyDecision: 'allowed' as const,
    modeRequiresApproval: false,
    risk: 'medium' as Risk,
    reversible: true,
    autoApproveReversible: false,
    requiredRisks: [] as Risk[],
  };

  it('requires nothing when no source asks for it', () => {
    expect(requiresApproval(base).required).toBe(false);
  });

  it('honours the project policy', () => {
    expect(requiresApproval({ ...base, policyDecision: 'approval-required' })).toMatchObject({
      required: true,
      reason: 'policy_requires_approval',
    });
  });

  it("honours the agent's own required risks", () => {
    expect(requiresApproval({ ...base, requiredRisks: ['medium'] }).required).toBe(true);
  });

  it('always requires approval for high and critical risk', () => {
    for (const risk of ['high', 'critical'] as const) {
      expect(requiresApproval({ ...base, risk }), risk).toMatchObject({
        required: true,
        reason: 'risk_requires_approval',
      });
    }
  });

  it('waives an approval the agent policy asked for when work is reversible', () => {
    expect(
      requiresApproval({
        ...base,
        requiredRisks: ['medium'],
        autoApproveReversible: true,
        reversible: true,
      }),
    ).toMatchObject({ required: false, reason: 'auto_approved_reversible' });
  });

  it('does not waive anything for irreversible work', () => {
    expect(
      requiresApproval({
        ...base,
        requiredRisks: ['medium'],
        autoApproveReversible: true,
        reversible: false,
      }).required,
    ).toBe(true);
  });

  it('never waives above medium risk, however the flag is set', () => {
    // A high or critical action reaching a human is the control this system
    // leans on hardest; a convenience flag must not be able to remove it.
    for (const risk of ['high', 'critical'] as const) {
      expect(
        requiresApproval({
          ...base,
          risk,
          autoApproveReversible: true,
          reversible: true,
          requiredRisks: [risk],
        }).required,
        risk,
      ).toBe(true);
    }
  });

  it('never waives an approval the run mode requires', () => {
    // Supervised mode means a human confirms; a profile flag must not opt out.
    expect(
      requiresApproval({
        ...base,
        modeRequiresApproval: true,
        autoApproveReversible: true,
        reversible: true,
      }),
    ).toMatchObject({ required: true, reason: 'mode_requires_approval' });
  });

  it('checks the mode before anything else, so its reason is the one reported', () => {
    const decision = requiresApproval({
      ...base,
      modeRequiresApproval: true,
      policyDecision: 'approval-required',
      risk: 'critical',
    });
    expect(decision.reason).toBe('mode_requires_approval');
  });
});
