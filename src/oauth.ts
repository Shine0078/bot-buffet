import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PkceAuthorizationRequest {
  actorId: string;
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  providerId: string;
  ttlMs?: number;
}

export interface PkceSession {
  actorId: string;
  providerId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export interface PkceAuthorizationResult {
  authorizationUrl: string;
  session: PkceSession;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 1024;

const base64Url = (value: Buffer): string =>
  value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

const randomToken = (bytes = 32): string => base64Url(randomBytes(bytes));

export const pkceChallenge = (verifier: string): string =>
  base64Url(createHash('sha256').update(verifier, 'ascii').digest());

const assertHttpEndpoint = (value: string, field: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`oauth_${field}_invalid`);
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`oauth_${field}_invalid`);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:'))
    throw new Error(`oauth_${field}_https_required`);
  return parsed;
};

const assertRedirectUri = (value: string): URL => {
  const parsed = assertHttpEndpoint(value, 'redirect_uri');
  if (parsed.search || parsed.hash) throw new Error('oauth_redirect_uri_query_or_fragment');
  return parsed;
};

const equalToken = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export class PkceSessionStore {
  private readonly sessions = new Map<string, PkceSession>();

  begin(input: PkceAuthorizationRequest): PkceAuthorizationResult {
    const now = Date.now();
    for (const [state, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(state);
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('oauth_session_capacity_exceeded');
    const endpoint = assertHttpEndpoint(input.authorizationEndpoint, 'authorization_endpoint');
    const redirectUri = assertRedirectUri(input.redirectUri);
    if (!input.providerId || !input.clientId)
      throw new Error('oauth_client_configuration_required');
    const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))];
    if (!scopes.length) throw new Error('oauth_scopes_required');
    const ttlMs = Math.min(Math.max(input.ttlMs ?? DEFAULT_TTL_MS, 60_000), MAX_TTL_MS);
    const createdAt = now;
    const session: PkceSession = {
      providerId: input.providerId,
      actorId: input.actorId,
      state: randomToken(),
      verifier: randomToken(48),
      redirectUri: redirectUri.toString(),
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    this.sessions.set(session.state, session);
    const url = new URL(endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', session.redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', session.state);
    url.searchParams.set('code_challenge', pkceChallenge(session.verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: url.toString(), session };
  }

  consume(providerId: string, state: string, actorId?: string, now = Date.now()): PkceSession {
    const session = this.sessions.get(state);
    this.sessions.delete(state);
    if (
      !session ||
      session.providerId !== providerId ||
      (actorId !== undefined && session.actorId !== actorId) ||
      now >= session.expiresAt
    )
      throw new Error('oauth_state_invalid_or_expired');
    if (!equalToken(session.state, state)) throw new Error('oauth_state_invalid_or_expired');
    return session;
  }

  size(): number {
    return this.sessions.size;
  }
}

export const validatePkceVerifier = (verifier: string, challenge: string): boolean =>
  /^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) && equalToken(pkceChallenge(verifier), challenge);
