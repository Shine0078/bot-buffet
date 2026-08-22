import { EvaluationCase, EvaluationResult, JsonSchema } from './types.js';
import { validateJsonSchema } from './security.js';

export type EvaluationOutputs = Record<string, unknown>;

/**
 * An inferential grader supplied by a reviewer that is separate from the agent that produced
 * the output. The harness never lets a judge see credentials, and a judge that throws or
 * returns a non-finite score fails the case rather than silently passing it.
 */
export interface JudgeVerdict {
  passed: boolean;
  score: number;
  rationale?: string;
}
export type Judge = (input: {
  caseId: string;
  input: unknown;
  expected: unknown;
  actual: unknown;
}) => JudgeVerdict;

export interface EvaluateOptions {
  /** Judges keyed by grader name, e.g. `llm-judge`. */
  judges?: Record<string, Judge>;
}

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

/** Case-insensitive containment after collapsing whitespace. */
const containsNormalized = (expected: unknown, actual: unknown): boolean => {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalize(actual).includes(normalize(expected));
};

/**
 * Regex grader. The pattern comes from the dataset, not the model. Length alone
 * does not prevent catastrophic backtracking (for example, `^(a+)+$`), so a
 * deliberately conservative structural check rejects the constructs most
 * commonly used to create exponential work before the synchronous RegExp API
 * is reached.
 */
export const isSafeRegexPattern = (pattern: string): boolean => {
  if (pattern.length > 512) return false;
  // Backreferences and lookarounds make execution cost/data dependencies hard
  // to bound and are unnecessary for evaluation matching.
  if (/\\(?:[1-9]\d*|k<[^>]+>)/u.test(pattern) || /\(\?[=!<]/u.test(pattern)) return false;
  // A quantified group/character class followed by another quantifier is the
  // classic nested-quantifier shape (`(a+)+`, `(?:a{1,3})*`).
  if (/(?:\([^()]*[+*{][^()]*\)|\[[^\]]*\][+*?])\s*(?:[+*?]|\{\d)/u.test(pattern)) return false;
  // Alternation of overlapping branches under a quantifier (`(a|aa)+`) also
  // causes unbounded backtracking as the input grows.
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/u.test(pattern)) return false;
  return true;
};

const matchesRegex = (expected: unknown, actual: unknown, evidence: string[]): boolean => {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  if (expected.length > 512) {
    evidence.push('grader:regex-too-long');
    return false;
  }
  if (!isSafeRegexPattern(expected)) {
    evidence.push('grader:regex-unsafe');
    return false;
  }
  try {
    return new RegExp(expected).test(actual);
  } catch {
    evidence.push('grader:regex-invalid');
    return false;
  }
};

/** Numeric grader with an inclusive tolerance carried on the case as `{ value, tolerance }`. */
const withinTolerance = (expected: unknown, actual: unknown, evidence: string[]): boolean => {
  const spec = expected as { value?: unknown; tolerance?: unknown } | null;
  const target = Number(spec && typeof spec === 'object' ? spec.value : expected);
  const tolerance = Number(spec && typeof spec === 'object' ? (spec.tolerance ?? 0) : 0);
  const observed = Number(actual);
  if (!Number.isFinite(target) || !Number.isFinite(observed) || !Number.isFinite(tolerance)) {
    evidence.push('grader:numeric-invalid');
    return false;
  }
  return Math.abs(observed - target) <= Math.abs(tolerance);
};

/** Structural grader: the output must satisfy the JSON schema carried on the case. */
const matchesSchema = (expected: unknown, actual: unknown, evidence: string[]): boolean => {
  try {
    const errors = validateJsonSchema(expected as JsonSchema, actual);
    if (errors.length) {
      evidence.push(`grader:schema-failed:${errors.join(',').slice(0, 96)}`);
      return false;
    }
    return true;
  } catch (error) {
    evidence.push(`grader:schema-failed:${(error as Error).message.slice(0, 64)}`);
    return false;
  }
};

const gradersFor = (evaluationCase: EvaluationCase): string[] =>
  evaluationCase.graders.length ? evaluationCase.graders : ['exact-match'];

export const evaluateCases = (
  cases: EvaluationCase[],
  outputs: EvaluationOutputs,
  options: EvaluateOptions = {},
): EvaluationResult[] =>
  cases.map((evaluationCase) => {
    const actual = outputs[evaluationCase.id];
    const graders = gradersFor(evaluationCase);
    const evidence: string[] = [];
    const scores: number[] = [];
    const decisions = graders.map((grader) => {
      if (grader === 'exact-match') return exactMatch(evaluationCase.expected, actual);
      if (grader === 'contains') return contains(evaluationCase.expected, actual);
      if (grader === 'contains-normalized')
        return containsNormalized(evaluationCase.expected, actual);
      if (grader === 'regex') return matchesRegex(evaluationCase.expected, actual, evidence);
      if (grader === 'numeric') return withinTolerance(evaluationCase.expected, actual, evidence);
      if (grader === 'json-schema') return matchesSchema(evaluationCase.expected, actual, evidence);
      const judge = options.judges?.[grader];
      if (judge) {
        try {
          const verdict = judge({
            caseId: evaluationCase.id,
            input: evaluationCase.input,
            expected: evaluationCase.expected,
            actual,
          });
          const score = Number(verdict?.score);
          if (!verdict || typeof verdict.passed !== 'boolean' || !Number.isFinite(score)) {
            evidence.push(`grader:judge-invalid:${grader.slice(0, 64)}`);
            return false;
          }
          scores.push(Math.min(1, Math.max(0, score)));
          evidence.push(`grader:judge:${grader.slice(0, 64)}:${verdict.passed ? 'pass' : 'fail'}`);
          if (verdict.rationale)
            evidence.push(`judge-rationale:${String(verdict.rationale).slice(0, 200)}`);
          return verdict.passed;
        } catch (error) {
          evidence.push(`grader:judge-error:${(error as Error).message.slice(0, 64)}`);
          return false;
        }
      }
      evidence.push(`grader:unsupported:${grader.slice(0, 64)}`);
      return false;
    });
    const passed = decisions.length > 0 && decisions.every(Boolean);
    evidence.unshift(`graders:${graders.join(',').slice(0, 256)}`);
    evidence.push(actual === undefined ? 'output:missing' : 'output:present');
    const judgeScore = scores.length
      ? scores.reduce((sum, value) => sum + value, 0) / scores.length
      : undefined;
    return {
      caseId: evaluationCase.id,
      passed,
      score: passed ? (judgeScore ?? 1) : (judgeScore ?? 0),
      evidence,
      ...(passed ? {} : { error: 'evaluation_mismatch' }),
    };
  });

export interface RegressionSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  /** Cases that passed in the baseline and now fail. These block a release. */
  regressions: string[];
  /** Cases that failed in the baseline and now pass. */
  fixes: string[];
  /** Cases present in the baseline but absent from this run. */
  missing: string[];
  /** Cases in this run that the baseline never covered. */
  added: string[];
}

/**
 * Compare a run against a golden baseline. A release gate must fail on any regression or any
 * missing case; new cases and fixes are reported but do not block.
 */
export function compareToBaseline(
  results: EvaluationResult[],
  baseline: EvaluationResult[],
): RegressionSummary {
  const baselineById = new Map(baseline.map((result) => [result.caseId, result]));
  const currentById = new Map(results.map((result) => [result.caseId, result]));
  const regressions: string[] = [];
  const fixes: string[] = [];
  const added: string[] = [];
  for (const result of results) {
    const previous = baselineById.get(result.caseId);
    if (!previous) {
      added.push(result.caseId);
      continue;
    }
    if (previous.passed && !result.passed) regressions.push(result.caseId);
    if (!previous.passed && result.passed) fixes.push(result.caseId);
  }
  const missing = baseline
    .map((result) => result.caseId)
    .filter((caseId) => !currentById.has(caseId));
  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? passed / results.length : 0,
    regressions: regressions.sort(),
    fixes: fixes.sort(),
    missing: missing.sort(),
    added: added.sort(),
  };
}

/** A release gate passes only when nothing regressed, nothing vanished, and the floor is met. */
export function releaseGate(
  summary: RegressionSummary,
  minimumPassRate = 1,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (summary.regressions.length) reasons.push('evaluation_regression');
  if (summary.missing.length) reasons.push('evaluation_case_missing');
  if (summary.passRate < minimumPassRate) reasons.push('evaluation_pass_rate_below_floor');
  return { allowed: reasons.length === 0, reasons };
}
