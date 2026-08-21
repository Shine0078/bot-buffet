import { describe, expect, it } from 'vitest';
import {
  DeviceSessionStore,
  PkceSessionStore,
  pkceChallenge,
  validatePkceVerifier,
} from '../src/oauth.js';

describe('OAuth 2.0 PKCE sessions', () => {
  it('creates a standards-compliant authorization URL and one-time session', () => {
    const store = new PkceSessionStore();
    const result = store.begin({
      actorId: 'user-1',
      providerId: 'provider-1',
      authorizationEndpoint: 'https://login.example.test/oauth/authorize',
      clientId: 'client-1',
      redirectUri: 'https://app.example.test/oauth/callback',
      scopes: ['models:read', 'models:read', ' profile '],
    });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.test/oauth/callback');
    expect(url.searchParams.get('scope')).toBe('models:read profile');
    expect(url.searchParams.get('state')).toBe(result.session.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(
      validatePkceVerifier(result.session.verifier, url.searchParams.get('code_challenge')!),
    ).toBe(true);
    expect(store.consume('provider-1', result.session.state, 'user-1')).toEqual(result.session);
    expect(() => store.consume('provider-1', result.session.state, 'user-1')).toThrow(
      'oauth_state_invalid_or_expired',
    );
  });

  it('rejects unsafe endpoints, mismatched providers, and expired state', () => {
    const store = new PkceSessionStore();
    expect(() =>
      store.begin({
        actorId: 'user-1',
        providerId: 'provider-1',
        authorizationEndpoint: 'http://login.example.test/authorize',
        clientId: 'client-1',
        redirectUri: 'https://app.example.test/callback',
        scopes: ['read'],
      }),
    ).toThrow('oauth_authorization_endpoint_https_required');
    expect(() =>
      store.begin({
        actorId: 'user-1',
        providerId: 'provider-1',
        authorizationEndpoint: 'https://login.example.test/authorize',
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:8787/callback?code=unsafe',
        scopes: ['read'],
      }),
    ).toThrow('oauth_redirect_uri_query_or_fragment');

    const result = store.begin({
      actorId: 'user-1',
      providerId: 'provider-1',
      authorizationEndpoint: 'https://login.example.test/authorize',
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:8787/callback',
      scopes: ['read'],
    });
    expect(() => store.consume('provider-2', result.session.state, 'user-1')).toThrow(
      'oauth_state_invalid_or_expired',
    );
    expect(() =>
      store.consume('provider-1', result.session.state, 'user-1', result.session.expiresAt),
    ).toThrow('oauth_state_invalid_or_expired');
    expect(pkceChallenge(result.session.verifier)).not.toBe(result.session.state);
  });
});

describe('OAuth 2.0 device authorization sessions', () => {
  it('keeps device codes server-side and binds polling to actor/provider', () => {
    const store = new DeviceSessionStore();
    const result = store.create({
      actorId: 'user-1',
      providerId: 'provider-1',
      clientId: 'client-1',
      deviceCode: 'device-secret-code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://login.example.test/device',
      expiresInSeconds: 120,
      intervalSeconds: 2,
    });
    expect(result).not.toHaveProperty('deviceCode');
    expect(result.userCode).toBe('ABCD-EFGH');
    expect(() => store.beginPoll('provider-2', 'user-1', result.sessionId)).toThrow(
      'device_session_invalid_or_expired',
    );
    const session = store.beginPoll('provider-1', 'user-1', result.sessionId, 1_000);
    expect(session.deviceCode).toBe('device-secret-code');
    expect(() => store.beginPoll('provider-1', 'user-1', result.sessionId, 1_500)).toThrow(
      'device_poll_too_fast',
    );
    expect(store.slowDown(result.sessionId)).toBe(7);
    store.complete(result.sessionId);
    expect(store.size()).toBe(0);
  });

  it('rejects unsafe verification endpoints and expires sessions', () => {
    const store = new DeviceSessionStore();
    expect(() =>
      store.create({
        actorId: 'user-1',
        providerId: 'provider-1',
        clientId: 'client-1',
        deviceCode: 'device-code',
        userCode: 'ABCD',
        verificationUri: 'http://login.example.test/device',
      }),
    ).toThrow('oauth_verification_uri_https_required');
    const result = store.create({
      actorId: 'user-1',
      providerId: 'provider-1',
      clientId: 'client-1',
      deviceCode: 'device-code',
      userCode: 'ABCD',
      verificationUri: 'https://login.example.test/device',
      expiresInSeconds: 60,
    });
    expect(() =>
      store.beginPoll('provider-1', 'user-1', result.sessionId, result.expiresAt),
    ).toThrow('device_session_invalid_or_expired');
  });
});
