import { createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 5 * 60_000;
const MAX_TOKEN_BYTES = 16_384;

type JsonWebKey = {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
};

type OidcClaims = {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  nonce?: unknown;
};

type CachedJwks = { expiresAt: number; keys: JsonWebKey[] };
const jwksCache = new Map<string, CachedJwks>();

export class AuthenticationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 401,
  ) {
    super(code);
  }
}

function isLoopbackBindHost(value: string): boolean {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith('127.');
  if (family === 6) return host === '::1' || /^::ffff:127\./.test(host);
  return false;
}

/** Fail closed before serving requests when identity mode and bind posture disagree. */
export function assertDeploymentAuthConfiguration(
  host: string,
  mode: string,
  nodeEnv = process.env.NODE_ENV,
): void {
  const exposed = !isLoopbackBindHost(host);
  if ((nodeEnv === 'production' || exposed) && mode !== 'production')
    throw new Error('production_auth_required_for_exposed_deployment');
  if (!['development', 'bootstrap', 'production'].includes(mode))
    throw new Error('auth_mode_invalid');
}

const unauthorized = (code: string): never => {
  throw new AuthenticationError(code);
};

const configurationError = (code: string): never => {
  throw new AuthenticationError(code, 503);
};

function requiredString(value: string | undefined, code: string): string {
  if (!value) return configurationError(code);
  return value;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) unauthorized('invalid_bearer');
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseJsonPart(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(decodeBase64Url(value).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      unauthorized('invalid_bearer');
    return parsed as Record<string, unknown>;
  } catch {
    return unauthorized('invalid_bearer');
  }
}

function bearerToken(req: IncomingMessage): string {
  const raw = String(req.headers.authorization ?? '');
  const token = raw.replace(/^Bearer\s+/i, '');
  if (!/^Bearer\s+/i.test(raw) || !token || Buffer.byteLength(token) > MAX_TOKEN_BYTES)
    unauthorized('unauthorized');
  return token;
}

function validateJwks(value: unknown): JsonWebKey[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    configurationError('oidc_jwks_invalid');
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || !keys.length) configurationError('oidc_jwks_invalid');
  const valid = (keys as unknown[]).filter((key): key is JsonWebKey =>
    Boolean(
      key &&
      typeof key === 'object' &&
      (key as JsonWebKey).kty === 'RSA' &&
      (key as JsonWebKey).alg === 'RS256' &&
      typeof (key as JsonWebKey).kid === 'string' &&
      typeof (key as JsonWebKey).n === 'string' &&
      typeof (key as JsonWebKey).e === 'string',
    ),
  );
  if (!valid.length) configurationError('oidc_jwks_invalid');
  return valid;
}

async function loadJwks(): Promise<JsonWebKey[]> {
  const inline = process.env.BOT_BUFFET_OIDC_JWKS_JSON;
  if (inline) {
    try {
      return validateJwks(JSON.parse(inline));
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      return configurationError('oidc_jwks_invalid');
    }
  }
  const jwksUri = requiredString(process.env.BOT_BUFFET_OIDC_JWKS_URI, 'oidc_jwks_uri_required');
  if (!/^https:\/\//i.test(jwksUri)) configurationError('oidc_jwks_uri_required');
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  let response: Response;
  try {
    response = await fetch(jwksUri, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AuthenticationError('oidc_jwks_unavailable', 503);
  }
  if (!response.ok) throw new AuthenticationError('oidc_jwks_unavailable', 503);
  let parsed: unknown;
  try {
    const body = await response.text();
    if (Buffer.byteLength(body) > 1_000_000) configurationError('oidc_jwks_too_large');
    parsed = JSON.parse(body);
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    return configurationError('oidc_jwks_invalid');
  }
  const keys = validateJwks(parsed);
  jwksCache.set(jwksUri, { expiresAt: Date.now() + JWKS_CACHE_MS, keys });
  return keys;
}

function stringClaim(claims: OidcClaims, name: keyof OidcClaims): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validateClaims(claims: OidcClaims): string {
  const issuer = process.env.BOT_BUFFET_OIDC_ISSUER;
  const audience = process.env.BOT_BUFFET_OIDC_AUDIENCE;
  const expectedIssuer = requiredString(issuer, 'oidc_configuration_incomplete');
  const expectedAudience = requiredString(audience, 'oidc_configuration_incomplete');
  if (claims.iss !== expectedIssuer) unauthorized('oidc_issuer_mismatch');
  const audiences =
    typeof claims.aud === 'string'
      ? [claims.aud]
      : Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === 'string')
        ? (claims.aud as string[])
        : [];
  if (!audiences.includes(expectedAudience)) unauthorized('oidc_audience_mismatch');
  if (audiences.length > 1 && claims.azp !== expectedAudience)
    unauthorized('oidc_authorized_party_mismatch');
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now - CLOCK_SKEW_SECONDS
  )
    unauthorized('oidc_token_expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_SECONDS)
    unauthorized('oidc_token_not_yet_valid');
  if (typeof claims.iat === 'number' && claims.iat > now + CLOCK_SKEW_SECONDS)
    unauthorized('oidc_token_issued_in_future');
  const expectedNonce = process.env.BOT_BUFFET_OIDC_NONCE;
  if (expectedNonce && claims.nonce !== expectedNonce) unauthorized('oidc_nonce_mismatch');
  const subject = stringClaim(claims, 'sub');
  if (!subject || subject.length > 256) return unauthorized('oidc_subject_invalid');
  return subject;
}

async function verifyOidc(req: IncomingMessage): Promise<string> {
  const token = bearerToken(req);
  requiredString(process.env.BOT_BUFFET_OIDC_ISSUER, 'oidc_configuration_incomplete');
  requiredString(process.env.BOT_BUFFET_OIDC_AUDIENCE, 'oidc_configuration_incomplete');
  const parts = token.split('.');
  if (parts.length !== 3) unauthorized('invalid_bearer');
  const headerPart = parts[0];
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (!headerPart || !payloadPart || !signaturePart) return unauthorized('invalid_bearer');
  const header = parseJsonPart(headerPart);
  const claims = parseJsonPart(payloadPart) as OidcClaims;
  if (
    header.alg !== 'RS256' ||
    (header.typ !== undefined && header.typ !== 'JWT') ||
    typeof header.kid !== 'string'
  )
    unauthorized('oidc_algorithm_rejected');
  const key = (await loadJwks()).find((candidate) => candidate.kid === header.kid);
  if (!key) return unauthorized('oidc_signing_key_not_found');
  let valid = false;
  try {
    const publicKey = createPublicKey({ key, format: 'jwk' });
    valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      decodeBase64Url(signaturePart),
    );
  } catch {
    unauthorized('oidc_signature_invalid');
  }
  if (!valid) unauthorized('oidc_signature_invalid');
  return validateClaims(claims);
}

function verifyBootstrap(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address))
    throw new AuthenticationError('bootstrap_loopback_only', 403);
  const expected = process.env.BOT_BUFFET_BOOTSTRAP_TOKEN;
  const presented = bearerToken(req);
  const expectedToken = requiredString(expected, 'bootstrap_token_not_configured');
  const expectedBytes = Buffer.from(expectedToken);
  const presentedBytes = Buffer.from(presented);
  if (
    expectedBytes.length !== presentedBytes.length ||
    !timingSafeEqual(expectedBytes, presentedBytes)
  )
    unauthorized('unauthorized');
  return 'local-user';
}

export async function authenticateRequest(req: IncomingMessage, mode: string): Promise<string> {
  if (mode === 'production') return verifyOidc(req);
  if (mode === 'bootstrap') return verifyBootstrap(req);
  if (mode === 'development') return String(req.headers['x-bot-buffet-user'] ?? 'local-user');
  return configurationError('auth_mode_invalid');
}
