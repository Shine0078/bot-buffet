import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  deliverySchedule,
  isKnownEvent,
  parseSignature,
  signPayload,
  verifySignature,
} from '../src/webhooks.js';

const secret = 's'.repeat(32);
const body = JSON.stringify({ type: 'run.completed', runId: 'run-1' });
const at = 1_800_000_000;

describe('webhook signing', () => {
  it('produces a parseable versioned signature and verifies it', () => {
    const header = signPayload(secret, body, at);
    expect(parseSignature(header)).toMatchObject({ version: 'v1', timestamp: at });
    expect(verifySignature(secret, body, header, at)).toEqual({ valid: true });
  });

  it('rejects a tampered body, a wrong secret, and a forged digest', () => {
    const header = signPayload(secret, body, at);
    expect(verifySignature(secret, body + ' ', header, at)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
    expect(verifySignature('x'.repeat(32), body, header, at).valid).toBe(false);
    const forged = `v1,t=${at},s=${'0'.repeat(64)}`;
    expect(verifySignature(secret, body, forged, at)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects replayed and future-dated deliveries outside the tolerance window', () => {
    const header = signPayload(secret, body, at);
    expect(verifySignature(secret, body, header, at + DEFAULT_TOLERANCE_SECONDS + 1)).toEqual({
      valid: false,
      reason: 'signature_stale',
    });
    expect(verifySignature(secret, body, header, at - DEFAULT_TOLERANCE_SECONDS - 1)).toEqual({
      valid: false,
      reason: 'signature_future',
    });
    // Inside the window a slightly delayed delivery is still accepted.
    expect(verifySignature(secret, body, header, at + DEFAULT_TOLERANCE_SECONDS - 1).valid).toBe(
      true,
    );
  });

  it('rejects malformed headers and unsupported versions', () => {
    for (const header of ['', 'garbage', 'v1,t=abc,s=deadbeef', `v1,s=${'a'.repeat(64)}`])
      expect(verifySignature(secret, body, header, at).reason).toBe('signature_malformed');
    expect(verifySignature(secret, body, `v9,t=${at},s=${'a'.repeat(64)}`, at).reason).toBe(
      'signature_version_unsupported',
    );
  });

  it('refuses to sign without a secret', () => {
    expect(() => signPayload('', body, at)).toThrow('webhook_secret_required');
  });

  it('builds a bounded exponential backoff schedule', () => {
    const schedule = deliverySchedule(5, 1000, 60_000);
    expect(schedule.map((item) => item.delayMs)).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(deliverySchedule(100).length).toBeLessThanOrEqual(10);
    expect(deliverySchedule(8, 1000, 5000).every((item) => item.delayMs <= 5000)).toBe(true);
  });

  it('recognizes only declared event types', () => {
    expect(isKnownEvent('run.completed')).toBe(true);
    expect(isKnownEvent('run.exploded')).toBe(false);
  });
});
