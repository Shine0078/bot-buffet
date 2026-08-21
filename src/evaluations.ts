import { EvaluationCase, EvaluationResult } from './types.js';

export type EvaluationOutputs = Record<string, unknown>;

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
};

const exactMatch = (expected: unknown, actual: unknown): boolean =>
  canonical(expected) === canonical(actual);

const contains = (expected: unknown, actual: unknown): boolean =>
  typeof expected === 'string' && typeof actual === 'string' && actual.includes(expected);

const gradersFor = (evaluationCase: EvaluationCase): string[] =>
  evaluationCase.graders.length ? evaluationCase.graders : ['exact-match'];

export const evaluateCases = (
  cases: EvaluationCase[],
  outputs: EvaluationOutputs,
): EvaluationResult[] =>
  cases.map((evaluationCase) => {
    const actual = outputs[evaluationCase.id];
    const graders = gradersFor(evaluationCase);
    const evidence: string[] = [];
    const decisions = graders.map((grader) => {
      if (grader === 'exact-match') return exactMatch(evaluationCase.expected, actual);
      if (grader === 'contains') return contains(evaluationCase.expected, actual);
      evidence.push(`grader:unsupported:${grader.slice(0, 64)}`);
      return false;
    });
    const passed = decisions.length > 0 && decisions.every(Boolean);
    evidence.unshift(`graders:${graders.join(',').slice(0, 256)}`);
    evidence.push(actual === undefined ? 'output:missing' : 'output:present');
    return {
      caseId: evaluationCase.id,
      passed,
      score: passed ? 1 : 0,
      evidence,
      ...(passed ? {} : { error: 'evaluation_mismatch' }),
    };
  });
