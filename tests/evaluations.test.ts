import { describe, expect, it } from 'vitest';
import { compareToBaseline, evaluateCases, releaseGate } from '../src/evaluations.js';
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

  it('supports normalized containment, regex, numeric tolerance, and schema graders', () => {
    const results = evaluateCases(
      [
        evaluationCase('normalized', 'System   Ready', ['contains-normalized']),
        evaluationCase('regex', '^ok-[0-9]+$', ['regex']),
        evaluationCase('numeric', { value: 10, tolerance: 0.5 }, ['numeric']),
        evaluationCase('schema', { type: 'object', required: ['id'] }, ['json-schema']),
      ],
      {
        normalized: 'the system ready now',
        regex: 'ok-42',
        numeric: 10.4,
        schema: { id: 'x' },
      },
    );
    expect(results.map((result) => result.passed)).toEqual([true, true, true, true]);
  });

  it('fails closed on hostile regex, non-numeric output, and schema violations', () => {
    const results = evaluateCases(
      [
        evaluationCase('bad-regex', '(', ['regex']),
        evaluationCase('long-regex', 'a'.repeat(600), ['regex']),
        evaluationCase('nan', { value: 1, tolerance: 0 }, ['numeric']),
        evaluationCase('schema', { type: 'object', required: ['id'] }, ['json-schema']),
      ],
      { 'bad-regex': 'x', 'long-regex': 'x', nan: 'not-a-number', schema: {} },
    );
    expect(results.every((result) => !result.passed)).toBe(true);
    expect(results[0]?.evidence).toContain('grader:regex-invalid');
    expect(results[1]?.evidence).toContain('grader:regex-too-long');
    expect(results[2]?.evidence).toContain('grader:numeric-invalid');
    expect(results[3]?.evidence.join('|')).toContain('grader:schema-failed');
  });

  it('uses a separated judge and fails closed when the judge misbehaves', () => {
    const results = evaluateCases(
      [
        evaluationCase('judged', 'a good answer', ['llm-judge']),
        evaluationCase('invalid', 'x', ['llm-judge']),
        evaluationCase('throwing', 'x', ['llm-judge']),
      ],
      { judged: 'a good answer indeed', invalid: 'y', throwing: 'z' },
      {
        judges: {
          'llm-judge': ({ caseId }) => {
            if (caseId === 'throwing') throw new Error('judge exploded');
            if (caseId === 'invalid')
              return { passed: true, score: Number.NaN } as unknown as {
                passed: boolean;
                score: number;
              };
            return { passed: true, score: 0.75, rationale: 'covers the expected claim' };
          },
        },
      },
    );
    expect(results[0]).toMatchObject({ passed: true, score: 0.75 });
    expect(results[0]?.evidence.join('|')).toContain('judge-rationale:covers the expected claim');
    expect(results[1]?.passed).toBe(false);
    expect(results[1]?.evidence).toContain('grader:judge-invalid:llm-judge');
    expect(results[2]?.passed).toBe(false);
    expect(results[2]?.evidence.join('|')).toContain('grader:judge-error:judge exploded');
  });
});

describe('evaluation regression gate', () => {
  const result = (caseId: string, passed: boolean) => ({
    caseId,
    passed,
    score: passed ? 1 : 0,
    evidence: [],
  });

  it('identifies regressions, fixes, missing, and added cases', () => {
    const summary = compareToBaseline(
      [result('a', false), result('b', true), result('d', true)],
      [result('a', true), result('b', false), result('c', true)],
    );
    expect(summary.regressions).toEqual(['a']);
    expect(summary.fixes).toEqual(['b']);
    expect(summary.missing).toEqual(['c']);
    expect(summary.added).toEqual(['d']);
    expect(summary.passRate).toBeCloseTo(2 / 3, 5);
  });

  it('blocks a release on regression, missing cases, or a low pass rate', () => {
    const clean = compareToBaseline([result('a', true)], [result('a', true)]);
    expect(releaseGate(clean)).toEqual({ allowed: true, reasons: [] });

    const regressed = compareToBaseline([result('a', false)], [result('a', true)]);
    expect(releaseGate(regressed).allowed).toBe(false);
    expect(releaseGate(regressed).reasons).toContain('evaluation_regression');

    const dropped = compareToBaseline([], [result('a', true)]);
    expect(releaseGate(dropped).reasons).toContain('evaluation_case_missing');

    const weak = compareToBaseline([result('a', false)], [result('a', false)]);
    expect(releaseGate(weak).reasons).toContain('evaluation_pass_rate_below_floor');
    expect(releaseGate(weak, 0).allowed).toBe(true);
  });
});
