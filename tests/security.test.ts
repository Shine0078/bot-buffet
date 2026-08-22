import { describe, expect, it } from 'vitest';
import {
  assertOffline,
  assertSafeEndpoint,
  assertWorkspacePath,
  decidePolicy,
  redactSecrets,
  validateCommand,
  validateJsonSchema,
} from '../src/security.js';

describe('security boundaries', () => {
  it('redacts secret-shaped keys and values', () => {
    expect(
      redactSecrets({ apiKey: 'sk-123456789012345', nested: 'Bearer abcdefghijklmnop' }),
    ).toEqual({ apiKey: '[REDACTED]', nested: '[REDACTED]' });
  });
  it('preserves operational token budgets and usage while redacting credentials', () => {
    expect(
      redactSecrets({
        tokenLimit: 64_000,
        max_tokens: 256,
        tokensIn: 12,
        outputTokens: 34,
        tokenEndpoint: 'https://issuer.example.test/oauth/token',
        accessToken: 'opaque-access-token',
      }),
    ).toEqual({
      tokenLimit: 64_000,
      max_tokens: 256,
      tokensIn: 12,
      outputTokens: 34,
      tokenEndpoint: '[REDACTED]',
      accessToken: '[REDACTED]',
    });
  });
  it('treats policy risks as a threshold rather than matching every lower risk', () => {
    const approveHighRisk = [
      { action: '*', effect: 'approval' as const, risks: ['high' as const] },
    ];
    // A safe, reversible read must not trip a rule written for high-risk actions.
    expect(decidePolicy('safe', 'p1', 'filesystem.read', approveHighRisk).decision).toBe('allowed');
    expect(decidePolicy('low', 'p1', 'filesystem.write', approveHighRisk).decision).toBe('allowed');
    // At or above the declared threshold, approval is required.
    expect(decidePolicy('high', 'p1', 'deploy', approveHighRisk).decision).toBe(
      'approval-required',
    );
    expect(decidePolicy('critical', 'p1', 'deploy', approveHighRisk).decision).toBe(
      'approval-required',
    );
  });

  it('denies before approving and scopes rules to their project', () => {
    const rules = [
      { action: 'deploy', effect: 'deny' as const },
      { action: '*', effect: 'approval' as const },
    ];
    expect(decidePolicy('low', 'p1', 'deploy', rules).decision).toBe('denied');
    const scoped = [{ action: '*', effect: 'deny' as const, scopes: ['p2'] }];
    expect(decidePolicy('high', 'p1', 'deploy', scoped).decision).toBe('allowed');
    expect(decidePolicy('high', 'p2', 'deploy', scoped).decision).toBe('denied');
  });

  it('preserves aggregate usage totals in cost reports', () => {
    expect(
      redactSecrets({
        totalTokensIn: 1200,
        totalTokensOut: 340,
        totalCostCents: 55,
        refreshToken: 'opaque-refresh-token',
      }),
    ).toEqual({
      totalTokensIn: 1200,
      totalTokensOut: 340,
      totalCostCents: 55,
      refreshToken: '[REDACTED]',
    });
  });
  it('rejects traversal and absolute paths', () => {
    expect(() => assertWorkspacePath('C:\\workspace', '..\\outside')).toThrow('traversal');
    expect(() => assertWorkspacePath('C:\\workspace', 'C:\\outside')).toThrow('absolute_path');
  });
  it('rejects shell metacharacters and network in offline mode', () => {
    expect(() => validateCommand('node app.js; whoami')).toThrow('shell_metacharacter');
    expect(() => assertOffline(true, false)).toThrow('cloud_provider_blocked');
    expect(() => validateCommand('node app.js', ['node'])).not.toThrow();
    expect(() => validateCommand('node --eval script', ['node'])).toThrow('code_execution_flag');
  });
  it('rejects metadata and credential-bearing provider endpoints', () => {
    expect(() => assertSafeEndpoint('http://169.254.169.254/latest')).toThrow(
      'metadata_or_loopback',
    );
    expect(() => assertSafeEndpoint('https://user:pass@example.com/v1')).toThrow(
      'embedded_credentials',
    );
    expect(assertSafeEndpoint('http://127.0.0.1:11434/v1', true).hostname).toBe('127.0.0.1');
    expect(() => assertSafeEndpoint('http://127.0.0.1:11434/v1')).toThrow('metadata_or_loopback');
  });
  it('validates typed tool schemas', () => {
    expect(
      validateJsonSchema(
        {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        { name: 3 },
      ),
    ).toContain('$.name:expected_string');
  });
});
