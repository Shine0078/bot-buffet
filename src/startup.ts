/**
 * Actionable startup configuration failures.
 *
 * The harness already fails closed on a misconfigured production deploy, which
 * is the right behaviour. What it did not do was explain itself: the container
 * exited with a raw Node stack trace ending in `Error: sandbox_runtime_required`
 * and nothing telling the operator what to set.
 *
 * That is the same defect the upstream install ladder was designed around —
 * never leave someone staring at a failure that does not name its remedy — and
 * it matters most here, because this message is what a failed deployment shows
 * at 3am.
 *
 * Each known startup error maps to what went wrong and what to do about it.
 * Anything unrecognised is re-thrown untouched rather than swallowed behind a
 * friendlier but less accurate message.
 */

export interface StartupDiagnosis {
  code: string;
  problem: string;
  remedy: string[];
}

const DIAGNOSES: Record<string, Omit<StartupDiagnosis, 'code'>> = {
  sandbox_runtime_required: {
    problem:
      'Production requires the container sandbox, but BOT_BUFFET_SANDBOX_MODE is not set to "docker".',
    remedy: [
      'Set BOT_BUFFET_SANDBOX_MODE=docker and give the process a reachable Docker daemon.',
      'Note: the shipped image contains no Docker CLI or socket, so docker mode cannot run',
      'from inside the container as built. See the sandbox topology decision in',
      'docs/owner-gates.md for the four supported deployment shapes.',
    ],
  },
  sandbox_image_required: {
    problem: 'Production requires a pinned sandbox image, and BOT_BUFFET_SANDBOX_IMAGE is unset.',
    remedy: [
      'Set BOT_BUFFET_SANDBOX_IMAGE to a digest-pinned reference, for example:',
      '  BOT_BUFFET_SANDBOX_IMAGE=node@sha256:<64 hex>',
      'Resolve a digest with: docker buildx imagetools inspect node:22-alpine',
    ],
  },
  sandbox_image_not_pinned: {
    problem:
      'BOT_BUFFET_SANDBOX_IMAGE names a mutable tag. A sandbox whose contents can change between runs is not a boundary.',
    remedy: [
      'Replace the tag with a digest: name@sha256:<64 hex>.',
      'Resolve one with: docker buildx imagetools inspect <image>',
    ],
  },
  sandbox_mode_invalid: {
    problem: 'BOT_BUFFET_SANDBOX_MODE is set to a value that is neither "local" nor "docker".',
    remedy: ['Set BOT_BUFFET_SANDBOX_MODE=docker for production, or =local for development.'],
  },
  'credential_vault:strong_master_key_required': {
    problem:
      'Production requires a strong BOT_BUFFET_MASTER_KEY, and the configured value is missing, too short, or still a placeholder.',
    remedy: [
      'Provide at least 32 random bytes from a KMS or secret manager, for example:',
      '  BOT_BUFFET_MASTER_KEY=$(openssl rand -base64 48)',
      'Do not reuse the .env.example placeholder; it is rejected deliberately.',
    ],
  },
  oidc_configuration_incomplete: {
    problem: 'Production authentication is enabled but the OIDC issuer or audience is not set.',
    remedy: [
      'Set BOT_BUFFET_OIDC_ISSUER, BOT_BUFFET_OIDC_AUDIENCE, and either',
      'BOT_BUFFET_OIDC_JWKS_URI (https) or BOT_BUFFET_OIDC_JWKS_JSON.',
    ],
  },
};

/** Look up a diagnosis for an error message, if one is known. */
export function diagnose(message: string): StartupDiagnosis | undefined {
  // Errors carry a bare code or a `code:detail` form; match on the code.
  const code = Object.keys(DIAGNOSES).find(
    (candidate) => message === candidate || message.startsWith(`${candidate}:`),
  );
  return code ? { code, ...DIAGNOSES[code]! } : undefined;
}

/** Render a diagnosis as the block an operator sees on a failed start. */
export function formatDiagnosis(diagnosis: StartupDiagnosis): string {
  return [
    '',
    'Bot Buffet could not start.',
    '',
    `  Problem: ${diagnosis.problem}`,
    '',
    '  To fix:',
    ...diagnosis.remedy.map((line) => `    ${line}`),
    '',
    `  Error code: ${diagnosis.code}`,
    '',
  ].join('\n');
}

/**
 * Run a startup assertion, converting a known configuration failure into an
 * actionable message and a clean exit.
 *
 * An unrecognised error is re-thrown. A friendly message that guessed would be
 * worse than the stack trace it replaced.
 */
export function withStartupDiagnostics<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnosis = diagnose(message);
    if (!diagnosis) throw error;
    console.error(formatDiagnosis(diagnosis));
    process.exit(1);
  }
}
