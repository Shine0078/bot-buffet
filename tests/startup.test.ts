import { describe, expect, it } from 'vitest';
import { diagnose, formatDiagnosis, withStartupDiagnostics } from '../src/startup.js';

/**
 * A misconfigured production deploy already failed closed, which is right.
 * What it did not do was explain itself: the container exited with a raw Node
 * stack trace ending in `Error: sandbox_runtime_required` and nothing telling
 * the operator what to set. This is the message a failed deployment shows, so
 * it is worth pinning.
 */

const KNOWN = [
  'sandbox_runtime_required',
  'sandbox_image_required',
  'sandbox_image_not_pinned',
  'sandbox_mode_invalid',
  'credential_vault:strong_master_key_required',
  'oidc_configuration_incomplete',
];

describe('diagnosing startup failures', () => {
  it('recognises every startup error the harness can throw', () => {
    for (const code of KNOWN) {
      expect(diagnose(code), code).toBeDefined();
    }
  });

  it('matches a code that carries a detail suffix', () => {
    // Errors are thrown as either a bare code or `code:detail`.
    expect(diagnose('sandbox_mode_invalid:banana')?.code).toBe('sandbox_mode_invalid');
  });

  it('returns nothing for an error it does not understand', () => {
    // A friendly message that guessed would be worse than the stack trace it
    // replaced, so unknown errors must fall through.
    for (const unknown of ['ECONNREFUSED', 'some other failure', '']) {
      expect(diagnose(unknown), unknown).toBeUndefined();
    }
  });

  it('gives every diagnosis a problem and at least one concrete remedy', () => {
    for (const code of KNOWN) {
      const diagnosis = diagnose(code)!;
      expect(diagnosis.problem.length, code).toBeGreaterThan(20);
      expect(diagnosis.remedy.length, code).toBeGreaterThan(0);
      // A remedy that does not name a setting or command is not actionable.
      expect(diagnosis.remedy.join(' '), code).toMatch(/BOT_BUFFET_|docker|openssl|docs\//);
    }
  });
});

describe('the message an operator actually sees', () => {
  it('states the problem, the fix, and the code', () => {
    const rendered = formatDiagnosis(diagnose('sandbox_runtime_required')!);
    expect(rendered).toContain('Bot Buffet could not start.');
    expect(rendered).toContain('Problem:');
    expect(rendered).toContain('To fix:');
    expect(rendered).toContain('Error code: sandbox_runtime_required');
  });

  it('points at the topology decision rather than implying a one-line fix', () => {
    // Setting SANDBOX_MODE=docker inside the shipped image cannot work, so the
    // message must not suggest it is sufficient on its own.
    const rendered = formatDiagnosis(diagnose('sandbox_runtime_required')!);
    expect(rendered).toContain('no Docker CLI or socket');
    expect(rendered).toContain('docs/owner-gates.md');
  });

  it('tells the operator how to generate a master key rather than only that one is needed', () => {
    const rendered = formatDiagnosis(diagnose('credential_vault:strong_master_key_required')!);
    expect(rendered).toMatch(/openssl rand/);
    expect(rendered).toMatch(/placeholder/i);
  });
});

describe('wrapping a startup assertion', () => {
  it('returns the value when the action succeeds', () => {
    expect(withStartupDiagnostics(() => 'started')).toBe('started');
  });

  it('re-throws an error it cannot diagnose, rather than swallowing it', () => {
    expect(() =>
      withStartupDiagnostics(() => {
        throw new Error('something entirely unexpected');
      }),
    ).toThrow('something entirely unexpected');
  });
});
