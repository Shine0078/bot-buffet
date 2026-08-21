import { describe, expect, it } from 'vitest';
import {
  assertOffline,
  assertSafeEndpoint,
  assertWorkspacePath,
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
