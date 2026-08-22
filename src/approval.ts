import type { Risk } from './types.js';

const RISK_RANK: Record<Risk, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Decide whether a tool call needs human approval.
 *
 * Combines three independent sources rather than letting any one of them
 * override the others:
 *
 *   - the project policy's decision,
 *   - the run mode's threshold (supervised approves every non-read),
 *   - the agent's own `approvalPolicy`.
 *
 * `autoApproveReversible` was declared and never read. It is a convenience for
 * routine reversible work, so it is deliberately the weakest of the three: it
 * can waive an approval the agent's own policy asked for, and it can do
 * nothing else. It cannot waive an approval the run mode requires — supervised
 * mode means a human confirms, and a profile flag must not be able to opt out
 * of that — and it never applies above medium risk, because a high or critical
 * action reaching a human is the single control this system leans on hardest.
 */
export function requiresApproval(input: {
  policyDecision: 'allowed' | 'denied' | 'approval-required';
  modeRequiresApproval: boolean;
  risk: Risk;
  reversible: boolean;
  autoApproveReversible: boolean;
  requiredRisks: Risk[];
}): { required: boolean; reason: string } {
  // The mode's requirement is absolute and is checked first.
  if (input.modeRequiresApproval) {
    return { required: true, reason: 'mode_requires_approval' };
  }
  if (input.risk === 'high' || input.risk === 'critical') {
    return { required: true, reason: 'risk_requires_approval' };
  }

  const policyAsks =
    input.policyDecision === 'approval-required' || input.requiredRisks.includes(input.risk);
  if (!policyAsks) return { required: false, reason: 'no_approval_required' };

  const waivable =
    input.autoApproveReversible && input.reversible && RISK_RANK[input.risk] <= RISK_RANK['medium'];
  if (waivable) return { required: false, reason: 'auto_approved_reversible' };

  return { required: true, reason: 'policy_requires_approval' };
}
