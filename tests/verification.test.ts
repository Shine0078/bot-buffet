import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_CHECKS,
  DETERMINISTIC_CHECKS,
  verifyDeterministic,
} from '../src/verification.js';
import { entity, type Task, type VerificationPolicy } from '../src/types.js';

/**
 * `verificationPolicy` was set on every profile and read by nothing: the
 * orchestrator ran one hardcoded check regardless. These pin the policy's
 * meaning, including the two decisions that stop verification from becoming
 * decorative again — an unknown check fails, and an empty policy under
 * `requireEvidence` still runs something.
 */

const task = (criteria: string[]): Task =>
  entity({
    kind: 'task',
    ownerId: 'u',
    scope: 'p',
    projectId: 'p',
    environmentId: 'e',
    title: 'T',
    description: 'D',
    acceptanceCriteria: criteria,
    status: 'ready',
    priority: 1,
    dependencyIds: [],
    labels: [],
  }) as Task;

const policy = (overrides: Partial<VerificationPolicy> = {}): VerificationPolicy => ({
  deterministic: [],
  inferential: [],
  requireEvidence: true,
  ...overrides,
});

describe('acceptance check', () => {
  it('passes when every criterion appears in the run state', () => {
    const result = verifyDeterministic(policy(), {
      task: task(['repository', 'tests']),
      state: { 'tool:fs.read': 'repository contents and tests output' },
    });
    expect(result.passed).toBe(true);
    expect(result.evidence).toEqual(['repository', 'tests']);
  });

  it('fails when a criterion is missing, and reports which were met', () => {
    const result = verifyDeterministic(policy(), {
      task: task(['repository', 'deployed']),
      state: { 'tool:fs.read': 'repository contents' },
    });
    expect(result.passed).toBe(false);
    expect(result.evidence).toEqual(['repository']);
    expect(result.results[0]?.detail).toMatch(/1 of 2/);
  });

  it('asserts nothing when a task declares no criteria', () => {
    const result = verifyDeterministic(policy(), { task: task([]), state: {} });
    expect(result.passed).toBe(true);
    expect(result.results[0]?.detail).toMatch(/No acceptance criteria/);
  });

  it('matches case-insensitively', () => {
    const result = verifyDeterministic(policy(), {
      task: task(['Repository']),
      state: { x: 'REPOSITORY' },
    });
    expect(result.passed).toBe(true);
  });
});

describe('policy drives which checks run', () => {
  it('runs exactly the checks the policy names', () => {
    const result = verifyDeterministic(policy({ deterministic: ['no-errors', 'tool-used'] }), {
      task: task(['never-matched']),
      state: { 'tool:fs.read': 'x' },
    });
    // acceptance is not named, so its failure must not count.
    expect(result.results.map((entry) => entry.name)).toEqual(['no-errors', 'tool-used']);
    expect(result.passed).toBe(true);
  });

  it('falls back to acceptance when the policy names nothing but requires evidence', () => {
    const result = verifyDeterministic(policy({ deterministic: [] }), {
      task: task(['x']),
      state: {},
    });
    expect(result.results.map((entry) => entry.name)).toEqual(['acceptance']);
    expect(result.passed).toBe(false);
  });

  it('verifies nothing when the policy is empty and evidence is not required', () => {
    // A legitimate choice for a chat or planning agent, but it has to be explicit.
    const result = verifyDeterministic(policy({ deterministic: [], requireEvidence: false }), {
      task: task(['x']),
      state: {},
    });
    expect(result.results).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails on an unknown check rather than ignoring it', () => {
    // A typo in a policy must not silently reduce what gets verified while the
    // run still reports success.
    const result = verifyDeterministic(policy({ deterministic: ['acceptance', 'no-such-check'] }), {
      task: task([]),
      state: {},
    });
    expect(result.passed).toBe(false);
    expect(result.unknownChecks).toEqual(['no-such-check']);
  });

  it('exposes the available check names so a policy can be validated', () => {
    expect(AVAILABLE_CHECKS.sort()).toEqual(
      ['acceptance', 'no-errors', 'no-injection', 'output-format', 'tool-used'].sort(),
    );
    for (const name of AVAILABLE_CHECKS) expect(typeof DETERMINISTIC_CHECKS[name]).toBe('function');
  });
});

describe('no-errors check', () => {
  it('fails when the state carries an error marker', () => {
    const result = verifyDeterministic(policy({ deterministic: ['no-errors'] }), {
      task: task([]),
      state: { 'tool:fs.write:error': 'denied' },
    });
    expect(result.passed).toBe(false);
    expect(result.results[0]?.evidence).toEqual(['tool:fs.write:error']);
  });

  it('passes on clean state', () => {
    const result = verifyDeterministic(policy({ deterministic: ['no-errors'] }), {
      task: task([]),
      state: { 'tool:fs.read': 'ok' },
    });
    expect(result.passed).toBe(true);
  });
});

describe('no-injection check', () => {
  it('fails when a tool result carried instruction-shaped content', () => {
    // A run can satisfy its acceptance criteria perfectly while having acted on
    // an injected instruction, so this is a verification concern and not only
    // an audit record.
    const result = verifyDeterministic(policy({ deterministic: ['no-injection'] }), {
      task: task([]),
      state: { 'tool:fs.read:injection': ['instruction_override'] },
    });
    expect(result.passed).toBe(false);
    expect(result.results[0]?.detail).toMatch(/instruction-shaped/i);
  });

  it('passes when nothing was flagged', () => {
    const result = verifyDeterministic(policy({ deterministic: ['no-injection'] }), {
      task: task([]),
      state: { 'tool:fs.read': 'plain output' },
    });
    expect(result.passed).toBe(true);
  });
});

describe('tool-used check', () => {
  it('fails a run that asserted success without executing anything', () => {
    const result = verifyDeterministic(policy({ deterministic: ['tool-used'] }), {
      task: task([]),
      state: { note: 'all done' },
    });
    expect(result.passed).toBe(false);
  });

  it('does not count trust or injection markers as tool executions', () => {
    const result = verifyDeterministic(policy({ deterministic: ['tool-used'] }), {
      task: task([]),
      state: { 'tool:fs.read:trust': 'untrusted', 'tool:fs.read:injection': [] },
    });
    expect(result.passed).toBe(false);
  });

  it('passes when a tool really ran', () => {
    const result = verifyDeterministic(policy({ deterministic: ['tool-used'] }), {
      task: task([]),
      state: { 'tool:fs.read': 'contents' },
    });
    expect(result.passed).toBe(true);
    expect(result.results[0]?.evidence).toEqual(['tool:fs.read']);
  });
});

describe('combined policies', () => {
  it('requires every named check to pass', () => {
    const input = {
      task: task(['repository']),
      state: { 'tool:fs.read': 'repository', 'tool:fs.read:error': 'partial' },
    };
    expect(verifyDeterministic(policy({ deterministic: ['acceptance'] }), input).passed).toBe(true);
    expect(
      verifyDeterministic(policy({ deterministic: ['acceptance', 'no-errors'] }), input).passed,
    ).toBe(false);
  });

  it('reports every check result, not only the failing one', () => {
    const result = verifyDeterministic(
      policy({ deterministic: ['acceptance', 'no-errors', 'tool-used'] }),
      { task: task(['missing']), state: { 'tool:fs.read': 'x' } },
    );
    expect(result.results).toHaveLength(3);
    expect(result.results.filter((entry) => entry.passed)).toHaveLength(2);
  });
});

describe('inferential policy', () => {
  it('fails closed when inferential checks are named without a reviewer', () => {
    const result = verifyDeterministic(policy({ inferential: ['llm-judge'] }), {
      task: task([]),
      state: { 'tool:fs.read': 'ok' },
    });
    expect(result.passed).toBe(false);
    expect(result.missingReviewer).toBe(true);
  });

  it('does not fail an empty inferential list', () => {
    const result = verifyDeterministic(policy({ deterministic: ['tool-used'] }), {
      task: task([]),
      state: { 'tool:fs.read': 'ok' },
    });
    expect(result.missingReviewer).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('fails closed when the named reviewer does not exist', () => {
    const result = verifyDeterministic(
      policy({ inferential: ['llm-judge'], reviewerAgentId: 'missing-reviewer' }),
      { task: task([]), state: { 'tool:fs.read': 'ok' }, reviewerExists: false },
    );
    expect(result.passed).toBe(false);
    expect(result.unknownReviewer).toBe(true);
  });
});

describe('output-format check', () => {
  it('fails markdown policy when the last response is unstructured', () => {
    const result = verifyDeterministic(policy({ deterministic: ['output-format'] }), {
      task: task([]),
      state: {},
      outputFormat: 'markdown',
      lastResponse: 'plain completion',
    });
    expect(result.passed).toBe(false);
    expect(result.results[0]?.name).toBe('output-format');
  });

  it('passes markdown policy when the last response has structure', () => {
    const result = verifyDeterministic(policy({ deterministic: ['output-format'] }), {
      task: task([]),
      state: {},
      outputFormat: 'markdown',
      lastResponse: '# Done\n\n- shipped',
    });
    expect(result.passed).toBe(true);
  });

  it('auto-runs output-format for markdown even when the policy did not name it', () => {
    const result = verifyDeterministic(policy({ deterministic: ['tool-used'] }), {
      task: task([]),
      state: { 'tool:fs.read': 'ok' },
      outputFormat: 'markdown',
      lastResponse: 'plain completion',
    });
    expect(result.results.map((entry) => entry.name)).toEqual(['tool-used', 'output-format']);
    expect(result.passed).toBe(false);
  });
});
