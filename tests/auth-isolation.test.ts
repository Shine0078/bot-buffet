import { afterEach, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Membership, Project, Workspace, entity } from '../src/types.js';

const oidcKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const oidcPublicJwk = oidcKeys.publicKey.export({ format: 'jwk' });
const base64Url = (value: string): string => Buffer.from(value).toString('base64url');

const tokenFor = (sub: string): string => {
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iss: 'https://issuer.example.test',
      aud: 'bot-buffet-test',
      sub,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  );
  const input = header + '.' + payload;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return input + '.' + signer.sign(oidcKeys.privateKey).toString('base64url');
};

const servers: Array<ReturnType<typeof createApi>> = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.BOT_BUFFET_AUTH_MODE;
  delete process.env.BOT_BUFFET_OIDC_ISSUER;
  delete process.env.BOT_BUFFET_OIDC_AUDIENCE;
  delete process.env.BOT_BUFFET_OIDC_JWKS_JSON;
});

async function startSeeded(): Promise<{ base: string; projectA: Project; projectB: Project }> {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-tenant-'));
  const store = createStore(dir);

  const workspaceA = entity({
    kind: 'workspace',
    ownerId: 'alice',
    scope: 'org',
    organizationId: 'org',
    name: 'A',
    slug: 'a',
  }) as Workspace;
  const workspaceB = entity({
    kind: 'workspace',
    ownerId: 'bob',
    scope: 'org',
    organizationId: 'org',
    name: 'B',
    slug: 'b',
  }) as Workspace;
  await store.insert(workspaceA);
  await store.insert(workspaceB);

  const projectA = entity({
    kind: 'project',
    ownerId: 'alice',
    scope: workspaceA.id,
    workspaceId: workspaceA.id,
    name: 'Alice project',
    slug: 'alice-project',
    archived: false,
  }) as Project;
  const projectB = entity({
    kind: 'project',
    ownerId: 'bob',
    scope: workspaceB.id,
    workspaceId: workspaceB.id,
    name: 'Bob project',
    slug: 'bob-project',
    archived: false,
  }) as Project;
  await store.insert(projectA);
  await store.insert(projectB);

  for (const membership of [
    entity({
      kind: 'membership',
      ownerId: 'alice',
      scope: workspaceA.id,
      userId: 'alice',
      workspaceId: workspaceA.id,
      role: 'owner',
    }) as Membership,
    entity({
      kind: 'membership',
      ownerId: 'bob',
      scope: workspaceB.id,
      userId: 'bob',
      workspaceId: workspaceB.id,
      role: 'owner',
    }) as Membership,
  ]) {
    await store.insert(membership);
  }

  const server = createApi({
    store,
    orchestrator: new EventEmitter() as unknown as Orchestrator,
    uiRoot: dir,
    vault: new CredentialVault(join(dir, 'credentials.enc.json'), 'test'),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_missing');

  process.env.BOT_BUFFET_AUTH_MODE = 'production';
  process.env.BOT_BUFFET_OIDC_ISSUER = 'https://issuer.example.test';
  process.env.BOT_BUFFET_OIDC_AUDIENCE = 'bot-buffet-test';
  process.env.BOT_BUFFET_OIDC_JWKS_JSON = JSON.stringify({
    keys: [{ ...oidcPublicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
  });

  return { base: 'http://127.0.0.1:' + address.port, projectA, projectB };
}

describe('cross-tenant isolation through verified production OIDC', () => {
  it('scopes a signed alice token to only her own project', async () => {
    const { base, projectA, projectB } = await startSeeded();
    const response = await fetch(base + '/api/v1/projects', {
      headers: { authorization: 'Bearer ' + tokenFor('alice') },
    });
    expect(response.status).toBe(200);
    const projects = (await response.json()) as Array<{ id: string }>;
    expect(projects.map((project) => project.id)).toContain(projectA.id);
    expect(projects.map((project) => project.id)).not.toContain(projectB.id);
  });

  it('scopes a signed bob token to only his own project', async () => {
    const { base, projectA, projectB } = await startSeeded();
    const response = await fetch(base + '/api/v1/projects', {
      headers: { authorization: 'Bearer ' + tokenFor('bob') },
    });
    expect(response.status).toBe(200);
    const projects = (await response.json()) as Array<{ id: string }>;
    expect(projects.map((project) => project.id)).toContain(projectB.id);
    expect(projects.map((project) => project.id)).not.toContain(projectA.id);
  });

  it('denies an unaffiliated signed token every project', async () => {
    const { base, projectA, projectB } = await startSeeded();
    const response = await fetch(base + '/api/v1/projects', {
      headers: { authorization: 'Bearer ' + tokenFor('mallory') },
    });
    expect(response.status).toBe(200);
    const projects = (await response.json()) as Array<{ id: string }>;
    expect(projects.map((project) => project.id)).not.toContain(projectA.id);
    expect(projects.map((project) => project.id)).not.toContain(projectB.id);
    expect(projects).toHaveLength(0);
  });

  it('denies a cross-tenant write attempt even with a valid signature', async () => {
    const { base, projectB } = await startSeeded();
    const response = await fetch(base + '/api/v1/projects/' + projectB.id, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer ' + tokenFor('alice'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Compromised' }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_failed',
      message: 'forbidden_or_not_found',
    });
  });
});
