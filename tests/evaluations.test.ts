import { describe, expect, it } from 'vitest';
import { evaluateCases } from '../src/evaluations.js';
import { EvaluationCase, now } from '../src/types.js';

const evaluationCase = (id: string, expected: unknown, graders: string[]): EvaluationCase => ({
  id,
  kind: 'evaluation-case',
  ownerId: 'user-1',
  scope: 'workspace-1',
  version: 1,
  createdAt: now(),
  updatedAt: now(),
  accessPolicy: { visibility: 'workspace', roles: {} },
  datasetId: 'dataset-1',
  name: id,
  input: {},
  expected,
  graders,
  tags: [],
});

describe('deterministic evaluation engine', () => {
  it('performs order-independent exact matching and records redacted evidence', () => {
    const result = evaluateCases(
      [evaluationCase('case-1', { answer: 'ok', count: 2 }, ['exact-match'])],
      { 'case-1': { count: 2, answer: 'ok' } },
    )[0]!;
    expect(result).toMatchObject({ caseId: 'case-1', passed: true, score: 1 });
    expect(result.evidence.join('|')).not.toContain('must-not-be-stored');
  });

  it('supports contains, missing output, and explicit unsupported graders', () => {
    const results = evaluateCases(
      [
        evaluationCase('contains', 'ready', ['contains']),
        evaluationCase('missing', 'ready', ['exact-match']),
        evaluationCase('unsupported', 'ready', ['llm-judge']),
      ],
      { contains: 'system ready' },
    );
    expect(results[0]).toMatchObject({ passed: true, score: 1 });
    expect(results[1]).toMatchObject({ passed: false, error: 'evaluation_mismatch' });
    expect(results[2]?.evidence).toContain('grader:unsupported:llm-judge');
  });
});
