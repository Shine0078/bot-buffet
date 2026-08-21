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

export interface DeviceAuthorizationPayload {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
}

export interface DeviceAuthorizationRequest {
  actorId: string;
  providerId: string;
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
}

export interface DeviceSession {
  sessionId: string;
  actorId: string;
  providerId: string;
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  createdAt: number;
  expiresAt: number;
  intervalSeconds: number;
  lastPollAt?: number;
}

export interface DeviceAuthorizationResult {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 1024;
const DEFAULT_DEVICE_TTL_SECONDS = 10 * 60;
const MAX_DEVICE_TTL_SECONDS = 15 * 60;
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const MAX_DEVICE_INTERVAL_SECONDS = 60;

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

export const validateDeviceAuthorizationEndpoint = (value: string): URL =>
  assertHttpEndpoint(value, 'device_authorization_endpoint');

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

/**
 * Bounded, actor/provider-bound device authorization sessions. The device code
 * never leaves this process after the provider response is received; callers
 * receive only the user code, verification URI, and an opaque poll session ID.
 */
export class DeviceSessionStore {
  private readonly sessions = new Map<string, DeviceSession>();

  create(input: DeviceAuthorizationRequest): DeviceAuthorizationResult {
    const now = Date.now();
    this.cleanup(now);
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('device_session_capacity_exceeded');
    if (!input.actorId || !input.providerId || !input.clientId)
      throw new Error('device_client_configuration_required');
    if (!input.deviceCode || input.deviceCode.length > 4096) throw new Error('device_code_invalid');
    if (!input.userCode || input.userCode.length > 256) throw new Error('device_user_code_invalid');
    const verificationUri = assertHttpEndpoint(input.verificationUri, 'verification_uri');
    const expiresInSeconds = Math.min(
      Math.max(Math.floor(input.expiresInSeconds ?? DEFAULT_DEVICE_TTL_SECONDS), 60),
      MAX_DEVICE_TTL_SECONDS,
    );
    const intervalSeconds = Math.min(
      Math.max(Math.floor(input.intervalSeconds ?? DEFAULT_DEVICE_INTERVAL_SECONDS), 1),
      MAX_DEVICE_INTERVAL_SECONDS,
    );
    const session: DeviceSession = {
      sessionId: randomToken(),
      actorId: input.actorId,
      providerId: input.providerId,
      clientId: input.clientId,
      deviceCode: input.deviceCode,
      userCode: input.userCode,
      verificationUri: verificationUri.toString(),
      createdAt: now,
      expiresAt: now + expiresInSeconds * 1000,
      intervalSeconds,
    };
    this.sessions.set(session.sessionId, session);
    return {
      sessionId: session.sessionId,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      expiresAt: session.expiresAt,
      intervalSeconds: session.intervalSeconds,
    };
  }

  beginPoll(
    providerId: string,
    actorId: string,
    sessionId: string,
    now = Date.now(),
  ): DeviceSession {
    this.cleanup(now);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('device_session_invalid_or_expired');
    if (session.providerId !== providerId || session.actorId !== actorId)
      throw new Error('device_session_invalid_or_expired');
    if (now >= session.expiresAt) {
      this.sessions.delete(sessionId);
      throw new Error('device_session_invalid_or_expired');
    }
    if (
      session.lastPollAt !== undefined &&
      now - session.lastPollAt < session.intervalSeconds * 1000
    )
      throw new Error('device_poll_too_fast');
    session.lastPollAt = now;
    return { ...session };
  }

  slowDown(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('device_session_invalid_or_expired');
    session.intervalSeconds = Math.min(MAX_DEVICE_INTERVAL_SECONDS, session.intervalSeconds + 5);
    return session.intervalSeconds;
  }

  complete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  size(): number {
    this.cleanup(Date.now());
    return this.sessions.size;
  }

  private cleanup(now: number): void {
    for (const [sessionId, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
  }
}

export const validatePkceVerifier = (verifier: string, challenge: string): boolean =>
  /^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) && equalToken(pkceChallenge(verifier), challenge);
