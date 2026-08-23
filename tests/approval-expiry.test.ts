import { describe, expect, it } from 'vitest';
import { approvalExpiryMs } from '../src/orchestrator.js';

describe('approval expiry', () => {
  it('uses the profile value when it is in bounds', () => {
    expect(approvalExpiryMs(1000)).toBe(1000);
    expect(approvalExpiryMs(900_000)).toBe(900_000);
  });

  it('rejects a zero or negative window instead of minting an already-expired approval', () => {
    expect(approvalExpiryMs(0)).toBe(1000);
    expect(approvalExpiryMs(-5)).toBe(1000);
  });

  it('caps an unbounded window at one day', () => {
    expect(approvalExpiryMs(10 * 24 * 60 * 60_000)).toBe(24 * 60 * 60_000);
  });

  it('defaults to fifteen minutes when the profile omitted the field', () => {
    expect(approvalExpiryMs(undefined)).toBe(15 * 60_000);
  });
});
