import type { Task, VerificationPolicy } from './types.js';

/**
 * Deterministic verification.
 *
 * `verificationPolicy` was set on every agent profile and read by nothing: the
 * orchestrator ran one hardcoded substring check over the acceptance criteria
 * regardless of what the profile declared. A profile asking for extra checks
 * got none, and one declaring `requireEvidence: false` still had evidence
 * required. The policy was decoration.
 *
 * Checks are named and registered here so a policy can only ask for checks
 * that exist. An unknown name fails the run rather than being ignored — a
 * verification step that silently does nothing is the worst possible outcome,
 * because the run reports success having verified less than it claimed.
 */

export interface VerificationInput {
  task: Task;
  /** Durable run state, which is where tool results and markers accumulate. */
  state: Record<string, unknown>;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  /** Concrete items the check matched, for the run timeline. */
  evidence: string[];
}

export type DeterministicCheck = (input: VerificationInput) => CheckResult;

/** Every acceptance criterion must appear in the accumulated run state. */
const acceptance: DeterministicCheck = ({ task, state }) => {
  const text = JSON.stringify(state).toLowerCase();
  const criteria = task.acceptanceCriteria;
  const evidence = criteria.filter((criterion) => text.includes(criterion.toLowerCase()));
  return {
    name: 'acceptance',
    // A task with no criteria cannot fail this check; it simply asserts nothing.
    passed: criteria.length === 0 || evidence.length === criteria.length,
    detail:
      criteria.length === 0
        ? 'No acceptance criteria declared.'
        : `${evidence.length} of ${criteria.length} acceptance criteria evidenced.`,
    evidence,
  };
};

/** No step recorded an error marker in the run state. */
const noErrors: DeterministicCheck = ({ state }) => {
  const failures = Object.entries(state)
    .filter(([key]) => key.endsWith(':error') || key === 'error')
    .map(([key]) => key);
  return {
    name: 'no-errors',
    passed: failures.length === 0,
    detail: failures.length
      ? `Error markers present: ${failures.join(', ')}.`
      : 'No error markers.',
    evidence: failures,
  };
};

/**
 * No tool result was flagged as carrying instruction-shaped content.
 *
 * A run that acted on a prompt-injection payload may satisfy its acceptance
 * criteria perfectly while having done something nobody asked for, so this is
 * available as a verification check and not only as an audit record.
 */
const noInjection: DeterministicCheck = ({ state }) => {
  const flagged = Object.keys(state).filter((key) => key.endsWith(':injection'));
  return {
    name: 'no-injection',
    passed: flagged.length === 0,
    detail: flagged.length
      ? `Instruction-shaped content detected in: ${flagged.join(', ')}.`
      : 'No instruction-shaped tool output detected.',
    evidence: flagged,
  };
};

/** At least one tool actually ran, so the run did more than assert success. */
const toolUsed: DeterministicCheck = ({ state }) => {
  const tools = Object.keys(state).filter(
    (key) => key.startsWith('tool:') && !key.includes(':trust') && !key.includes(':injection'),
  );
  return {
    name: 'tool-used',
    passed: tools.length > 0,
    detail: tools.length ? `Tools executed: ${tools.join(', ')}.` : 'No tool was executed.',
    evidence: tools,
  };
};

export const DETERMINISTIC_CHECKS: Record<string, DeterministicCheck> = {
  acceptance,
  'no-errors': noErrors,
  'no-injection': noInjection,
  'tool-used': toolUsed,
};

export const AVAILABLE_CHECKS = Object.keys(DETERMINISTIC_CHECKS);

export interface VerificationOutcome {
  passed: boolean;
  /** Flattened evidence, preserved for the existing run-step contract. */
  evidence: string[];
  results: CheckResult[];
  /** Checks the policy named that do not exist. */
  unknownChecks: string[];
  missingReviewer: boolean;
}

/**
 * Run the policy's deterministic checks.
 *
 * `requireEvidence` decides what an empty policy means. With it true, a policy
 * naming no checks still runs `acceptance`, so "verified" cannot be claimed
 * without something having been checked. With it false, an empty policy
 * verifies nothing and says so — which is a legitimate choice for a chat or
 * planning agent, but has to be explicit.
 */
export function verifyDeterministic(
  policy: VerificationPolicy,
  input: VerificationInput,
): VerificationOutcome {
  const names = policy.deterministic.length
    ? policy.deterministic
    : policy.requireEvidence
      ? ['acceptance']
      : [];

  const unknownChecks = names.filter((name) => !DETERMINISTIC_CHECKS[name]);
  const results = names
    .filter((name) => DETERMINISTIC_CHECKS[name])
    .map((name) => DETERMINISTIC_CHECKS[name]!(input));

  // An unknown check fails the run. Ignoring it would let a typo in a policy
  // silently reduce what gets verified while the run still reports success.
  const missingReviewer = policy.inferential.length > 0 && !policy.reviewerAgentId;
  const passed =
    unknownChecks.length === 0 && results.every((result) => result.passed) && !missingReviewer;

  return {
    passed,
    evidence: results.flatMap((result) => result.evidence),
    results,
    unknownChecks,
    missingReviewer,
  };
}
