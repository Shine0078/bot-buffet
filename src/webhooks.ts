import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook delivery signing. Signatures follow the widely used scheme of signing a timestamped
 * payload so a captured request cannot be replayed later, and verification is constant-time so
 * a comparison cannot be used as an oracle.
 */
export const SIGNATURE_VERSION = 'v1';
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The exact bytes covered by the signature: version, timestamp, and body. */
export const signingPayload = (timestamp: number, body: string): string =>
  `${SIGNATURE_VERSION}.${timestamp}.${body}`;

export function signPayload(secret: string, body: string, timestamp: number): string {
  if (!secret) throw new Error('webhook_secret_required');
  const digest = createHmac('sha256', secret).update(signingPayload(timestamp, body)).digest('hex');
  return `${SIGNATURE_VERSION},t=${timestamp},s=${digest}`;
}

export interface ParsedSignature {
  version: string;
  timestamp: number;
  digest: string;
}

export function parseSignature(header: string): ParsedSignature | undefined {
  const match = /^(v\d+),t=(\d+),s=([a-f0-9]{64})$/.exec(String(header ?? '').trim());
  if (!match) return undefined;
  return { version: match[1]!, timestamp: Number(match[2]), digest: match[3]! };
}

export interface VerifyResult {
  valid: boolean;
  reason?:
    | 'signature_malformed'
    | 'signature_version_unsupported'
    | 'signature_stale'
    | 'signature_future'
    | 'signature_mismatch';
}

/**
 * Verify a delivery signature. Rejects malformed headers, unsupported versions, timestamps
 * outside the replay window, and digests that do not match, using a constant-time comparison.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  const parsed = parseSignature(header);
  if (!parsed) return { valid: false, reason: 'signature_malformed' };
  if (parsed.version !== SIGNATURE_VERSION)
    return { valid: false, reason: 'signature_version_unsupported' };
  const age = nowSeconds - parsed.timestamp;
  if (age > toleranceSeconds) return { valid: false, reason: 'signature_stale' };
  if (age < -toleranceSeconds) return { valid: false, reason: 'signature_future' };
  const expected = Buffer.from(
    createHmac('sha256', secret).update(signingPayload(parsed.timestamp, body)).digest('hex'),
    'utf8',
  );
  const provided = Buffer.from(parsed.digest, 'utf8');
  if (expected.length !== provided.length) return { valid: false, reason: 'signature_mismatch' };
  return timingSafeEqual(expected, provided)
    ? { valid: true }
    : { valid: false, reason: 'signature_mismatch' };
}

export interface DeliveryAttempt {
  attempt: number;
  delayMs: number;
}

/**
 * Exponential backoff with full jitter, bounded so a failing endpoint cannot hold a delivery
 * worker open indefinitely.
 */
export function deliverySchedule(
  maxAttempts = 5,
  baseDelayMs = 1000,
  maxDelayMs = 60_000,
): DeliveryAttempt[] {
  const attempts: DeliveryAttempt[] = [];
  for (let attempt = 1; attempt <= Math.max(1, Math.min(10, maxAttempts)); attempt += 1)
    attempts.push({
      attempt,
      delayMs: Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)),
    });
  return attempts;
}

/** Events a webhook may subscribe to. Unknown events are rejected at registration time. */
export const WEBHOOK_EVENTS = [
  'run.created',
  'run.started',
  'run.blocked',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.stopped',
  'run.forked',
  'run.rolled_back',
  'run.failed',
  'run.completed',
  'approval.requested',
  'tool.executed',
  'verification.failed',
  'budget.warning',
  'budget.exceeded',
  'checkpoint.created',
  'policy.changed',
] as const;

export const isKnownEvent = (event: string): boolean =>
  (WEBHOOK_EVENTS as readonly string[]).includes(event);
