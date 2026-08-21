import { describe, expect, it } from 'vitest';
import { assembleContext, estimateTokens } from '../src/context.js';

describe('context budgeting', () => {
  it('compacts lower-ranked items and preserves source citations', () => {
    const result = assembleContext(
      [
        {
          id: 'fresh',
          text: 'important evidence',
          scope: 'project',
          relevance: 1,
          sourceIds: ['source-1'],
        },
        {
          id: 'old',
          text: 'older detail '.repeat(40),
          scope: 'project',
          relevance: 0.1,
          sourceIds: ['source-2'],
        },
      ],
      32,
    );
    expect(result.compacted).toBe(true);
    expect(result.selectedIds).toContain('fresh');
    expect(result.citations).toContain('source-1');
    expect(result.estimatedTokens).toBeLessThanOrEqual(32);
  });
  it('uses a deterministic token estimate', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });
});
