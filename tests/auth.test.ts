import { afterEach, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { AuthenticationError, authenticateRequest } from '../src/auth.js';

/**
 * Authentication is the boundary every other control sits behind, so the
 * failure cases matter more than the success case. These exercise the ways a
 * token can be wrong — forged algorithm, wrong key, tampered payload, wrong
 * audience, expired, replayed from the future — rather than only proving that
 * a good token works.
 */

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = keys.publicKey.export({ format: 'jwk' });
const otherPublicJwk = otherKeys.publicKey.export({ format: 'jwk' });

const ENV_KEYS = [
  'BOT_BUFFET_OIDC_ISSUER',
  'BOT_BUFFET_OIDC_AUDIENCE',
  'BOT_BUFFET_OIDC_JWKS_JSON',
  'BOT_BUFFET_OIDC_JWKS_URI',
  'BOT_BUFFET_OIDC_NONCE',
  'BOT_BUFFET_BOOTSTRAP_TOKEN',
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureOidc(jwk: unknown = publicJwk, kid = 'test-key') {
  process.env.BOT_BUFFET_OIDC_ISSUER = 'https://issuer.example.test';
  process.env.BOT_BUFFET_OIDC_AUDIENCE = 'bot-buffet-test';
  process.env.BOT_BUFFET_OIDC_JWKS_JSON = JSON.stringify({
    keys: [{ ...(jwk as object), kid, alg: 'RS256', use: 'sig' }],
  });
}

const b64 = (value: string): string => Buffer.from(value).toString('base64url');

function signJwt(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  privateKey = keys.privateKey,
): string {
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...header }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(
    JSON.stringify({
      iss: 'https://issuer.example.test',
      aud: 'bot-buffet-test',
      sub: 'alice',
      iat: now,
      exp: now + 300,
      ...claims,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${payload}`);
  signer.end();
  return `${head}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

/** Minimal IncomingMessage stand-in: only headers and the socket are read. */
function request(headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') {
  const socket = new EventEmitter() as unknown as { remoteAddress: string };
  socket.remoteAddress = remoteAddress;
  return { headers, socket } as unknown as IncomingMessage;
}

const bearer = (token: string, remoteAddress?: string) =>
  request({ authorization: `Bearer ${token}` }, remoteAddress);

async function expectRejection(promise: Promise<unknown>, code: string, status?: number) {
  await expect(promise).rejects.toThrow(AuthenticationError);
  await promise.catch((error: AuthenticationError) => {
    expect(error.message).toBe(code);
    if (status !== undefined) expect(error.status).toBe(status);
  });
}

describe('production OIDC authentication', () => {
  it('accepts a correctly signed token and returns its subject', async () => {
    configureOidc();
    await expect(authenticateRequest(bearer(signJwt()), 'production')).resolves.toBe('alice');
  });

  it('rejects a token signed by a different key', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(bearer(signJwt({}, {}, otherKeys.privateKey)), 'production'),
      'oidc_signature_invalid',
    );
  });

  it('rejects a token whose payload was tampered with after signing', async () => {
    configureOidc();
    const [head, , signature] = signJwt().split('.');
    const forged = b64(
      JSON.stringify({
        iss: 'https://issuer.example.test',
        aud: 'bot-buffet-test',
        sub: 'attacker',
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    );
    await expectRejection(
      authenticateRequest(bearer(`${head}.${forged}.${signature}`), 'production'),
      'oidc_signature_invalid',
    );
  });

  it('refuses algorithm confusion, including alg none and HMAC', async () => {
    configureOidc();
    for (const alg of ['none', 'HS256', 'RS512', 'ES256']) {
      await expectRejection(
        authenticateRequest(bearer(signJwt({}, { alg })), 'production'),
        'oidc_algorithm_rejected',
      );
    }
  });

  it('refuses a token with no key id, since the key could not be chosen', async () => {
    configureOidc();
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64(JSON.stringify({ sub: 'alice' }));
    await expectRejection(
      authenticateRequest(bearer(`${head}.${payload}.sig`), 'production'),
      'oidc_algorithm_rejected',
    );
  });

  it('refuses a token naming a key that is not in the key set', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(bearer(signJwt({}, { kid: 'unknown-key' })), 'production'),
      'oidc_signing_key_not_found',
    );
  });

  it('refuses a token whose type is not JWT', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(bearer(signJwt({}, { typ: 'at+jwt' })), 'production'),
      'oidc_algorithm_rejected',
    );
  });
});

describe('OIDC claim validation', () => {
  it('refuses a mismatched issuer', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(bearer(signJwt({ iss: 'https://evil.example' })), 'production'),
      'oidc_issuer_mismatch',
    );
  });

  it('refuses a mismatched audience, and accepts an array containing it', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(bearer(signJwt({ aud: 'someone-else' })), 'production'),
      'oidc_audience_mismatch',
    );
    await expect(
      authenticateRequest(bearer(signJwt({ aud: ['bot-buffet-test'] })), 'production'),
    ).resolves.toBe('alice');
  });

  it('requires an authorized party when the token has several audiences', async () => {
    configureOidc();
    // A multi-audience token without azp could have been minted for another
    // relying party and replayed here.
    await expectRejection(
      authenticateRequest(bearer(signJwt({ aud: ['bot-buffet-test', 'other-app'] })), 'production'),
      'oidc_authorized_party_mismatch',
    );
    await expect(
      authenticateRequest(
        bearer(signJwt({ aud: ['bot-buffet-test', 'other-app'], azp: 'bot-buffet-test' })),
        'production',
      ),
    ).resolves.toBe('alice');
  });

  it('refuses an audience claim that is neither a string nor a string array', async () => {
    configureOidc();
    for (const aud of [42, null, [1, 2], {}]) {
      await expectRejection(
        authenticateRequest(bearer(signJwt({ aud })), 'production'),
        'oidc_audience_mismatch',
      );
    }
  });

  it('refuses an expired token and one with no expiry at all', async () => {
    configureOidc();
    const now = Math.floor(Date.now() / 1000);
    await expectRejection(
      authenticateRequest(bearer(signJwt({ exp: now - 3600 })), 'production'),
      'oidc_token_expired',
    );
    await expectRejection(
      authenticateRequest(bearer(signJwt({ exp: undefined })), 'production'),
      'oidc_token_expired',
    );
    await expectRejection(
      authenticateRequest(bearer(signJwt({ exp: 'soon' })), 'production'),
      'oidc_token_expired',
    );
  });

  it('refuses a token that is not yet valid or was issued in the future', async () => {
    configureOidc();
    const now = Math.floor(Date.now() / 1000);
    await expectRejection(
      authenticateRequest(bearer(signJwt({ nbf: now + 3600 })), 'production'),
      'oidc_token_not_yet_valid',
    );
    await expectRejection(
      authenticateRequest(bearer(signJwt({ iat: now + 3600 })), 'production'),
      'oidc_token_issued_in_future',
    );
  });

  it('tolerates small clock skew rather than failing valid tokens', async () => {
    configureOidc();
    const now = Math.floor(Date.now() / 1000);
    await expect(
      authenticateRequest(bearer(signJwt({ nbf: now + 5, iat: now + 5 })), 'production'),
    ).resolves.toBe('alice');
  });

  it('enforces a nonce when one is configured', async () => {
    configureOidc();
    process.env.BOT_BUFFET_OIDC_NONCE = 'expected-nonce';
    await expectRejection(
      authenticateRequest(bearer(signJwt()), 'production'),
      'oidc_nonce_mismatch',
    );
    await expect(
      authenticateRequest(bearer(signJwt({ nonce: 'expected-nonce' })), 'production'),
    ).resolves.toBe('alice');
  });

  it('refuses a missing, empty, or oversized subject', async () => {
    configureOidc();
    for (const sub of [undefined, '', 42, 'x'.repeat(257)]) {
      await expectRejection(
        authenticateRequest(bearer(signJwt({ sub })), 'production'),
        'oidc_subject_invalid',
      );
    }
  });
});

describe('bearer token handling', () => {
  it('refuses a request with no authorization header', async () => {
    configureOidc();
    await expectRejection(authenticateRequest(request(), 'production'), 'unauthorized');
  });

  it('refuses a scheme other than Bearer', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(request({ authorization: 'Basic abc' }), 'production'),
      'unauthorized',
    );
  });

  it('refuses an empty or absurdly large token', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(request({ authorization: 'Bearer ' }), 'production'),
      'unauthorized',
    );
    await expectRejection(
      authenticateRequest(bearer('x'.repeat(200_000)), 'production'),
      'unauthorized',
    );
  });

  it('refuses a token that is not three parts', async () => {
    configureOidc();
    for (const token of ['abc', 'a.b', 'a.b.c.d']) {
      await expectRejection(authenticateRequest(bearer(token), 'production'), 'invalid_bearer');
    }
  });

  it('refuses parts that are not base64url or not JSON objects', async () => {
    configureOidc();
    await expectRejection(
      authenticateRequest(bearer('not base64!.also bad!.sig'), 'production'),
      'invalid_bearer',
    );
    // A JSON array is valid JSON but is not a claims object.
    const arrayPayload = `${b64(JSON.stringify({ alg: 'RS256', kid: 'test-key' }))}.${b64('[1,2]')}.sig`;
    await expectRejection(
      authenticateRequest(bearer(arrayPayload), 'production'),
      'invalid_bearer',
    );
  });
});

describe('OIDC configuration errors are not authentication failures', () => {
  it('reports incomplete configuration as a server error, not unauthorized', async () => {
    delete process.env.BOT_BUFFET_OIDC_ISSUER;
    delete process.env.BOT_BUFFET_OIDC_AUDIENCE;
    // 503, because the deployment is misconfigured — the caller did nothing wrong.
    await expectRejection(
      authenticateRequest(bearer('a.b.c'), 'production'),
      'oidc_configuration_incomplete',
      503,
    );
  });

  it('rejects a key set with no usable RSA signing key', async () => {
    process.env.BOT_BUFFET_OIDC_ISSUER = 'https://issuer.example.test';
    process.env.BOT_BUFFET_OIDC_AUDIENCE = 'bot-buffet-test';
    for (const jwks of [
      '{"keys":[]}',
      '{"keys":[{"kty":"oct","alg":"HS256","kid":"k"}]}',
      '{"keys":[{"kty":"RSA","alg":"RS512","kid":"k","n":"a","e":"b"}]}',
      '{"keys":[{"kty":"RSA","alg":"RS256","n":"a","e":"b"}]}',
      '{"keys":{}}',
      'not json',
    ]) {
      process.env.BOT_BUFFET_OIDC_JWKS_JSON = jwks;
      await expectRejection(
        authenticateRequest(bearer(signJwt()), 'production'),
        'oidc_jwks_invalid',
        503,
      );
    }
  });

  it('requires an https key set URI when no inline key set is given', async () => {
    process.env.BOT_BUFFET_OIDC_ISSUER = 'https://issuer.example.test';
    process.env.BOT_BUFFET_OIDC_AUDIENCE = 'bot-buffet-test';
    delete process.env.BOT_BUFFET_OIDC_JWKS_JSON;
    process.env.BOT_BUFFET_OIDC_JWKS_URI = 'http://issuer.example.test/jwks';
    await expectRejection(
      authenticateRequest(bearer(signJwt()), 'production'),
      'oidc_jwks_uri_required',
      503,
    );
  });

  it('selects the matching key when the key set holds several', async () => {
    process.env.BOT_BUFFET_OIDC_ISSUER = 'https://issuer.example.test';
    process.env.BOT_BUFFET_OIDC_AUDIENCE = 'bot-buffet-test';
    process.env.BOT_BUFFET_OIDC_JWKS_JSON = JSON.stringify({
      keys: [
        { ...(otherPublicJwk as object), kid: 'other-key', alg: 'RS256', use: 'sig' },
        { ...(publicJwk as object), kid: 'test-key', alg: 'RS256', use: 'sig' },
      ],
    });
    await expect(authenticateRequest(bearer(signJwt()), 'production')).resolves.toBe('alice');
  });
});

describe('bootstrap and development modes', () => {
  it('accepts the configured bootstrap token from loopback only', async () => {
    process.env.BOT_BUFFET_BOOTSTRAP_TOKEN = 'bootstrap-secret-value';
    await expect(authenticateRequest(bearer('bootstrap-secret-value'), 'bootstrap')).resolves.toBe(
      'local-user',
    );
    for (const address of ['::1', '::ffff:127.0.0.1']) {
      await expect(
        authenticateRequest(bearer('bootstrap-secret-value', address), 'bootstrap'),
      ).resolves.toBe('local-user');
    }
  });

  it('refuses bootstrap from a non-loopback address with 403', async () => {
    process.env.BOT_BUFFET_BOOTSTRAP_TOKEN = 'bootstrap-secret-value';
    await expectRejection(
      authenticateRequest(bearer('bootstrap-secret-value', '203.0.113.9'), 'bootstrap'),
      'bootstrap_loopback_only',
      403,
    );
  });

  it('refuses a wrong bootstrap token, whatever its length', async () => {
    process.env.BOT_BUFFET_BOOTSTRAP_TOKEN = 'bootstrap-secret-value';
    for (const token of ['wrong', 'bootstrap-secret-valuX', 'bootstrap-secret-value-longer']) {
      await expectRejection(authenticateRequest(bearer(token), 'bootstrap'), 'unauthorized');
    }
  });

  it('reports an unconfigured bootstrap token as a server error', async () => {
    delete process.env.BOT_BUFFET_BOOTSTRAP_TOKEN;
    await expectRejection(
      authenticateRequest(bearer('anything'), 'bootstrap'),
      'bootstrap_token_not_configured',
      503,
    );
  });

  it('uses the development header only in development mode', async () => {
    await expect(
      authenticateRequest(request({ 'x-bot-buffet-user': 'dev-user' }), 'development'),
    ).resolves.toBe('dev-user');
    await expect(authenticateRequest(request(), 'development')).resolves.toBe('local-user');

    // The same header must carry no weight in production.
    configureOidc();
    await expectRejection(
      authenticateRequest(request({ 'x-bot-buffet-user': 'admin' }), 'production'),
      'unauthorized',
    );
  });

  it('refuses an unrecognised auth mode rather than defaulting to something', async () => {
    await expectRejection(
      authenticateRequest(request(), 'anything-else'),
      'auth_mode_invalid',
      503,
    );
  });
});
