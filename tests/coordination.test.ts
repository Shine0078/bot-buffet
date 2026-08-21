import { describe, expect, it } from 'vitest';
import { compareOutputs, runBounded } from '../src/coordination.js';

describe('multi-agent coordination', () => {
  it('compares evidence and identifies disagreements', () => {
    const result = compareOutputs([
      { agentId: 'a', text: 'same answer', evidence: ['test-pass'] },
      { agentId: 'b', text: 'different answer', evidence: ['test-fail'] },
    ]);
    expect(result.winner).toBeDefined();
    expect(result.consensus).toBe(false);
    expect(result.disagreements).toContain('test-pass');
  });
  it('runs independent jobs under a concurrency bound', async () => {
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 6 }, (_, index) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return index;
    });
    expect(await runBounded(jobs, 2)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
