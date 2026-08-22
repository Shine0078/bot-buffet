import { describe, expect, it } from 'vitest';
import {
  ALL_RUN_MODES,
  buildSystemPrompt,
  canStartInMode,
  decideMode,
  escalationOutcome,
  modeConstraints,
  requiresApproval,
  type EscalationPolicy,
} from '../src/modes.js';
import type { Risk, RunMode } from '../src/types.js';

/**
 * `RunMode` was declared on every profile and stored on every run, and nothing
 * read it: a `plan` run could mutate files exactly like an `autonomous` one,
 * and `emergency-stop` did nothing. These tests pin the semantics so a mode
 * cannot go back to being decorative.
 */

const RISKS: Risk[] = ['safe', 'low', 'medium', 'high', 'critical'];
const RANK: Record<Risk, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

describe('mode constraints', () => {
  it('defines every mode in the type', () => {
    const expected: RunMode[] = [
      'plan',
      'execute',
      'review',
      'chat',
      'supervised',
      'autonomous',
      'maintenance',
      'emergency-stop',
      'custom',
    ];
    expect([...ALL_RUN_MODES].sort()).toEqual([...expected].sort());
  });

  it('gives every mode a description that explains its refusals', () => {
    for (const mode of ALL_RUN_MODES) {
      expect(modeConstraints(mode).description.length, mode).toBeGreaterThan(15);
    }
  });

  it('fails closed for an unrecognised mode', () => {
    // A mode added to the type but not to the table must not be waved through.
    const constraints = modeConstraints('not-a-mode' as RunMode);
    expect(constraints.canRun).toBe(false);
    expect(canStartInMode('not-a-mode' as RunMode)).toBe(false);
  });

  it('never lets any mode reach critical without approval', () => {
    for (const mode of ALL_RUN_MODES) {
      const decision = decideMode(mode, 'critical');
      if (decision.allowed) expect(decision.requiresApproval, mode).toBe(true);
    }
  });
});

describe('read-only modes', () => {
  it('lets plan and review run safe tools only', () => {
    for (const mode of ['plan', 'review'] as const) {
      expect(decideMode(mode, 'safe')).toEqual({ allowed: true, requiresApproval: false });
      for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
        const decision = decideMode(mode, risk);
        expect(decision.allowed, `${mode}/${risk}`).toBe(false);
        if (!decision.allowed) expect(decision.code).toBe('mode_risk_exceeded');
      }
    }
  });

  it('refuses a mutating tool outright rather than escalating it to approval', () => {
    // The mode is saying this kind of work is not what the run is for, which
    // an approval prompt would quietly convert into "ask and proceed".
    const decision = decideMode('plan', 'medium');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('mode_risk_exceeded');
  });
});

describe('chat mode', () => {
  it('runs no tools at all, at any risk', () => {
    for (const risk of RISKS) {
      const decision = decideMode('chat', risk);
      expect(decision.allowed, risk).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe('mode_tools_disabled');
    }
  });
});

describe('emergency stop', () => {
  it('halts the run rather than merely restricting it', () => {
    expect(canStartInMode('emergency-stop')).toBe(false);
    for (const risk of RISKS) {
      const decision = decideMode('emergency-stop', risk);
      expect(decision.allowed, risk).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe('mode_run_halted');
    }
  });

  it('is the only mode that cannot start', () => {
    const halted = ALL_RUN_MODES.filter((mode) => !canStartInMode(mode));
    expect(halted).toEqual(['emergency-stop']);
  });
});

describe('supervised mode', () => {
  it('approves everything that is not read-only', () => {
    expect(decideMode('supervised', 'safe')).toEqual({ allowed: true, requiresApproval: false });
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      expect(decideMode('supervised', risk), risk).toEqual({
        allowed: true,
        requiresApproval: true,
      });
    }
  });
});

describe('autonomous mode', () => {
  it('cannot reach a critical action with nobody watching', () => {
    const decision = decideMode('autonomous', 'critical');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('mode_risk_exceeded');
  });

  it('still requires approval above medium risk', () => {
    expect(decideMode('autonomous', 'medium')).toEqual({ allowed: true, requiresApproval: false });
    expect(decideMode('autonomous', 'high')).toEqual({ allowed: true, requiresApproval: true });
  });
});

describe('maintenance mode', () => {
  it('is limited to low-risk, reversible work', () => {
    expect(decideMode('maintenance', 'safe')).toEqual({ allowed: true, requiresApproval: false });
    expect(decideMode('maintenance', 'low')).toEqual({ allowed: true, requiresApproval: false });
    for (const risk of ['medium', 'high', 'critical'] as const) {
      expect(decideMode('maintenance', risk).allowed, risk).toBe(false);
    }
  });
});

describe('custom mode', () => {
  it('carries no implicit relaxation and still cannot reach critical', () => {
    // Otherwise defining a custom mode would be a way around the ceilings.
    expect(decideMode('custom', 'critical').allowed).toBe(false);
    expect(decideMode('custom', 'high')).toEqual({ allowed: true, requiresApproval: true });
  });
});

describe('modes only ever narrow', () => {
  it('never permits a risk above the mode ceiling', () => {
    for (const mode of ALL_RUN_MODES) {
      const ceiling = modeConstraints(mode).maxToolRisk;
      for (const risk of RISKS) {
        const decision = decideMode(mode, risk);
        if (RANK[risk] > RANK[ceiling]) expect(decision.allowed, `${mode}/${risk}`).toBe(false);
      }
    }
  });

  it('requires approval for anything above the mode approval threshold', () => {
    for (const mode of ALL_RUN_MODES) {
      const { approvalAbove } = modeConstraints(mode);
      for (const risk of RISKS) {
        const decision = decideMode(mode, risk);
        if (decision.allowed && RANK[risk] > RANK[approvalAbove]) {
          expect(decision.requiresApproval, `${mode}/${risk}`).toBe(true);
        }
      }
    }
  });

  it('execute is the most permissive mode, and is still not unbounded', () => {
    const execute = modeConstraints('execute');
    for (const mode of ALL_RUN_MODES) {
      expect(RANK[modeConstraints(mode).maxToolRisk], mode).toBeLessThanOrEqual(
        RANK[execute.maxToolRisk],
      );
    }
    // Even execute sends high and critical to a human.
    expect(decideMode('execute', 'high').allowed && decideMode('execute', 'high')).toMatchObject({
      requiresApproval: true,
    });
  });
});

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

describe('system prompt assembly', () => {
  const profile = (overrides: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) => ({
    systemInstructions: 'You maintain the billing service.',
    projectRules: [],
    skills: [],
    ...overrides,
  });

  it('carries the instructions through unchanged', () => {
    expect(buildSystemPrompt(profile())).toBe('You maintain the billing service.');
  });

  it('lists project rules as rules rather than running them together', () => {
    const prompt = buildSystemPrompt(
      profile({ projectRules: ['Never touch migrations', 'Prefer small commits'] }),
    );
    expect(prompt).toContain('- Never touch migrations');
    expect(prompt).toContain('- Prefer small commits');
  });

  it('lists skills by name only, which is the point of progressive disclosure', () => {
    // `skills` was declared on every profile and used nowhere, so an agent
    // never learned its own skills existed. Names only, so the full text does
    // not occupy the context budget on every step.
    const prompt = buildSystemPrompt(
      profile({ skills: ['docs/skills/refunds.md', 'docs/skills/dunning.md'] }),
    );
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('- docs/skills/refunds.md');
    expect(prompt).toContain('- docs/skills/dunning.md');
  });

  it('omits empty sections instead of emitting bare headings', () => {
    const prompt = buildSystemPrompt(profile());
    expect(prompt).not.toContain('Project rules');
    expect(prompt).not.toContain('Available skills');
  });

  it('keeps instructions first so a skill list cannot displace them', () => {
    const prompt = buildSystemPrompt(profile({ projectRules: ['rule'], skills: ['skill'] }));
    expect(prompt.indexOf('You maintain the billing service.')).toBe(0);
    expect(prompt.indexOf('Project rules')).toBeLessThan(prompt.indexOf('Available skills'));
  });
});

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
