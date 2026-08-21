import { describe, expect, it, afterEach } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { entity, Agent, Environment, ModelProvider, Project, Run, Task } from '../src/types.js';
import { PkceSessionStore } from '../src/oauth.js';

const servers: Array<ReturnType<typeof createApi>> = [];
const oidcKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const oidcPublicJwk = oidcKeys.publicKey.export({ format: 'jwk' });
const base64Url = (value: string): string => Buffer.from(value).toString('base64url');
const oidcToken = (claims: Record<string, unknown> = {}): string => {
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iss: 'https://issuer.example.test',
      aud: 'bot-buffet-test',
      sub: 'local-user',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    }),
  );
  const input = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(oidcKeys.privateKey).toString('base64url')}`;
};
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.BOT_BUFFET_AUTH_MODE;
  delete process.env.BOT_BUFFET_BOOTSTRAP_TOKEN;
  delete process.env.BOT_BUFFET_OIDC_ISSUER;
  delete process.env.BOT_BUFFET_OIDC_AUDIENCE;
  delete process.env.BOT_BUFFET_OIDC_JWKS_JSON;
  delete process.env.BOT_BUFFET_TEST_PROVIDER_TOKEN;
});

async function start(
  auth = false,
  discoverLocal: NonNullable<Parameters<typeof createApi>[0]['discoverLocal']> = async () => [],
) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-api-'));
  const server = createApi({
    store: createStore(dir),
    orchestrator: new EventEmitter() as unknown as Orchestrator,
    uiRoot: dir,
    vault: new CredentialVault(join(dir, 'credentials.enc.json'), 'test'),
    discoverLocal,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_missing');
  if (auth) {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    process.env.BOT_BUFFET_OIDC_ISSUER = 'https://issuer.example.test';
    process.env.BOT_BUFFET_OIDC_AUDIENCE = 'bot-buffet-test';
    process.env.BOT_BUFFET_OIDC_JWKS_JSON = JSON.stringify({
      keys: [{ ...oidcPublicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
    });
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('API boundary controls', () => {
  it('exposes authenticated loopback model discovery without cloud fallback', async () => {
    const base = await start(false, async () => [
      {
        providerKind: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
        reachable: true,
        models: ['qwen2.5-coder'],
      },
    ]);
    const response = await fetch(`${base}/api/v1/local-models/discover`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: [
        {
          providerKind: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          reachable: true,
          models: ['qwen2.5-coder'],
        },
      ],
      offlineOnly: true,
    });
  });

  it('registers discovered local models idempotently and keeps them offline-only', async () => {
    const base = await start();
    const payload = {
      providerKind: 'ollama',
      endpoint: 'http://127.0.0.1:11434/v1',
      modelName: 'qwen2.5-coder',
    };
    const first = await fetch(`${base}/api/v1/local-models/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      offlineOnly: boolean;
      provider: { id: string };
      model: { id: string; local: boolean };
    };
    expect(created).toMatchObject({ offlineOnly: true, model: { local: true } });
    const second = await fetch(`${base}/api/v1/local-models/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      provider: { id: created.provider.id },
      model: { id: created.model.id },
      offlineOnly: true,
    });
    const cloudKind = await fetch(`${base}/api/v1/local-models/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, providerKind: 'openai' }),
    });
    expect(cloudKind.status).toBe(400);
  });

  it('creates and lists validated model routes', async () => {
    const base = await start();
    const providerResponse = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Route host',
        providerKind: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
      }),
    });
    const provider = (await providerResponse.json()) as { id: string };
    const modelResponse = await fetch(`${base}/api/v1/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: provider.id, modelName: 'route-model', local: true }),
    });
    const model = (await modelResponse.json()) as { id: string };
    const createdResponse = await fetch(`${base}/api/v1/model-routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Private first',
        strategy: 'privacy-first',
        modelIds: [model.id],
        fallbackModelIds: [model.id],
        offlineOnly: false,
      }),
    });
    expect(createdResponse.status).toBe(201);
    await expect(createdResponse.json()).resolves.toMatchObject({
      kind: 'model-route',
      name: 'Private first',
      strategy: 'privacy-first',
      modelIds: [model.id],
      fallbackModelIds: [model.id],
    });
    const listed = await fetch(`${base}/api/v1/model-routes`);
    expect(await listed.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Private first' })]),
    );
    const invalid = await fetch(`${base}/api/v1/model-routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'unknown', modelIds: ['m'] }),
    });
    expect(invalid.status).toBe(400);
    const invalidCost = await fetch(`${base}/api/v1/model-routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelIds: ['m'], maxCostCents: 'not-a-number' }),
    });
    expect(invalidCost.status).toBe(400);
  });

  it('creates scoped environments, agents, and tasks with safe defaults', async () => {
    const base = await start();
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Agent project' }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const environmentResponse = await fetch(`${base}/api/v1/environments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, name: 'Sandbox', network: 'blocked' }),
    });
    expect(environmentResponse.status).toBe(201);
    const environment = (await environmentResponse.json()) as { id: string; network: string };
    expect(environment.network).toBe('blocked');
    const agentResponse = await fetch(`${base}/api/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, environmentId: environment.id, name: 'Desk' }),
    });
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as {
      id: string;
      version: number;
      projectId: string;
      profile: {
        network: string;
        concurrencyLimit: number;
        version: number;
        approvalPolicy: { requiredRisks: string[] };
      };
    };
    expect(agent).toMatchObject({
      projectId: project.id,
      profile: { network: 'blocked', concurrencyLimit: 1 },
    });
    expect(agent.profile.approvalPolicy.requiredRisks).toEqual(['high', 'critical']);
    const updatedAgentResponse = await fetch(`${base}/api/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: agent.version,
        changeSummary: 'Tune profile',
        profile: { name: 'Desk v2', tokenLimit: 64_000 },
      }),
    });
    expect(updatedAgentResponse.status).toBe(200);
    const updatedAgent = (await updatedAgentResponse.json()) as {
      version: number;
      profile: { name: string; tokenLimit: number; version: number; approvalPolicy: unknown };
    };
    expect(updatedAgent).toMatchObject({
      version: agent.version + 1,
      profile: { name: 'Desk v2', tokenLimit: 64_000, version: agent.profile.version + 1 },
    });
    expect(updatedAgent.profile.approvalPolicy).toEqual(agent.profile.approvalPolicy);
    const staleAgent = await fetch(`${base}/api/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: agent.version, profile: { name: 'stale' } }),
    });
    expect(staleAgent.status).toBe(400);
    const auditResponse = await fetch(`${base}/api/v1/audit`);
    expect(auditResponse.status).toBe(200);
    const audit = (await auditResponse.json()) as Array<{
      action: string;
      resourceId: string;
      metadata: { entityVersion: number; profileVersion: number; changedFields: string[] };
    }>;
    const profileAudit = audit.find(
      (event) => event.action === 'agent.profile.update' && event.resourceId === agent.id,
    );
    expect(profileAudit).toMatchObject({
      metadata: {
        entityVersion: agent.version + 1,
        profileVersion: agent.profile.version + 1,
        changedFields: ['name', 'tokenLimit'],
      },
    });
    const taskResponse = await fetch(`${base}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        environmentId: environment.id,
        assigneeAgentId: agent.id,
        title: 'First task',
        acceptanceCriteria: ['Has evidence'],
      }),
    });
    expect(taskResponse.status).toBe(201);
    const task = (await taskResponse.json()) as { id: string; version: number };
    expect(task).toMatchObject({
      kind: 'task',
      projectId: project.id,
      assigneeAgentId: agent.id,
      status: 'ready',
    });
    const transitioned = await fetch(`${base}/api/v1/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: task.version, status: 'running' }),
    });
    expect(transitioned.status).toBe(200);
    const running = (await transitioned.json()) as { version: number; status: string };
    expect(running).toMatchObject({ status: 'running', version: task.version + 1 });
    const stale = await fetch(`${base}/api/v1/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: task.version, status: 'done' }),
    });
    expect(stale.status).toBe(400);
    expect(await (await fetch(`${base}/api/v1/agents`)).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: agent.id })]),
    );
    expect(await (await fetch(`${base}/api/v1/tasks`)).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'First task' })]),
    );
  });

  it('rejects non-finite model routing metadata', async () => {
    const base = await start();
    const providerResponse = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Local model host',
        providerKind: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
      }),
    });
    const provider = (await providerResponse.json()) as { id: string };
    const invalid = await fetch(`${base}/api/v1/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: provider.id,
        modelName: 'bad-cost',
        inputCostPerMillionCents: 'not-a-number',
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it('adds correlation ids and rejects oversized bodies', async () => {
    const base = await start();
    const response = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(2_100_000) }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('requires verified production OIDC bearer auth before API access', async () => {
    const base = await start(true);
    const response = await fetch(`${base}/api/v1/bootstrap`);
    expect(response.status).toBe(401);
    const authorized = await fetch(`${base}/api/v1/bootstrap`, {
      headers: { authorization: `Bearer ${oidcToken()}` },
    });
    expect(authorized.status).toBe(200);
  });
  it('fails closed when production OIDC configuration is missing', async () => {
    const base = await start();
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    const response = await fetch(`${base}/api/v1/bootstrap`, {
      headers: { authorization: 'Bearer configured-but-unverifiable' },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'oidc_configuration_incomplete' });
  });
  it('rejects a bearer with an invalid OIDC signature', async () => {
    const base = await start(true);
    const invalid = `${oidcToken().slice(0, -4)}aaaa`;
    const response = await fetch(`${base}/api/v1/bootstrap`, {
      headers: { authorization: `Bearer ${invalid}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'oidc_signature_invalid' });
  });
  it('rejects static traversal instead of serving outside UI root', async () => {
    const base = await start();
    const response = await fetch(`${base}/../package.json`);
    expect(response.status).not.toBe(200);
  });
  it('deletes an inactive project through the scoped lifecycle route', async () => {
    const base = await start();
    const createdResponse = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Disposable' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    const deletedResponse = await fetch(`${base}/api/v1/projects/${created.id}`, {
      method: 'DELETE',
    });
    expect(deletedResponse.status).toBe(204);
    const listed = await fetch(`${base}/api/v1/projects`);
    expect(await listed.json()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
  });
  it('keeps plugin updates disabled and supports integrity-pinned rollback/delete', async () => {
    const base = await start();
    const createdResponse = await fetch(`${base}/api/v1/plugins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Example', source: 'local' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string; enabled: boolean };
    expect(created.enabled).toBe(false);
    const updatedResponse = await fetch(`${base}/api/v1/plugins/${created.id}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.1.0', integritySha256: 'a'.repeat(64) }),
    });
    expect(updatedResponse.status).toBe(200);
    const deletedResponse = await fetch(`${base}/api/v1/plugins/${created.id}`, {
      method: 'DELETE',
    });
    expect(deletedResponse.status).toBe(204);
  });
  it('records an environment credential reference without persisting or accepting its secret', async () => {
    process.env.BOT_BUFFET_TEST_PROVIDER_TOKEN = 'env-secret-that-must-not-cross-the-api';
    const base = await start();
    const createdResponse = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Environment Provider',
        providerKind: 'openai',
        endpoint: 'https://api.example.test/v1',
        authType: 'env',
        environmentVariable: 'BOT_BUFFET_TEST_PROVIDER_TOKEN',
      }),
    });
    expect(createdResponse.status).toBe(201);
    const payload = (await createdResponse.json()) as {
      credentialSource?: { authType: string; environmentVariable: string };
    };
    expect(payload.credentialSource).toEqual({
      authType: 'env',
      environmentVariable: 'BOT_BUFFET_TEST_PROVIDER_TOKEN',
    });
    expect(JSON.stringify(payload)).not.toContain('env-secret-that-must-not-cross-the-api');
    const rejected = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid Environment Provider',
        providerKind: 'openai',
        endpoint: 'https://api.example.test/v1',
        authType: 'env',
        environmentVariable: 'BOT_BUFFET_TEST_PROVIDER_TOKEN',
        token: 'submitted-secret',
      }),
    });
    expect(rejected.status).toBe(400);
  });
  it('requires a versioned memory approval transition and audits the decision', async () => {
    const base = await start();
    const createdResponse = await fetch(`${base}/api/v1/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        namespace: 'session',
        namespaceId: 'session-1',
        text: 'candidate memory',
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      version: number;
      approved: boolean;
    };
    expect(created.approved).toBe(false);
    const approvedResponse = await fetch(`${base}/api/v1/memory/${created.id}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true, version: created.version }),
    });
    expect(approvedResponse.status).toBe(200);
    expect(await approvedResponse.json()).toMatchObject({ approved: true });
    const stale = await fetch(`${base}/api/v1/memory/${created.id}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: false, version: created.version }),
    });
    expect(stale.status).toBe(400);
  });
  it('starts an actor-bound OAuth PKCE flow without returning the verifier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-api-'));
    const store = createStore(dir);
    const provider = entity({
      kind: 'model-provider',
      ownerId: 'local-user',
      scope: 'workspace_local',
      name: 'OAuth Provider',
      providerKind: 'openai-compatible' as const,
      endpoint: 'https://api.example.test/v1',
      enabled: true,
      health: 'unknown' as const,
      capabilities: {
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embeddings: false,
        reranking: false,
      },
      oauth: {
        authorizationEndpoint: 'https://login.example.test/authorize',
        tokenEndpoint: 'https://login.example.test/token',
        clientId: 'client-1',
        scopes: ['models:read'],
        redirectUri: 'http://127.0.0.1:8787/oauth/callback',
      },
    }) as ModelProvider;
    await store.insert(provider);
    const server = createApi({
      store,
      orchestrator: new EventEmitter() as unknown as Orchestrator,
      uiRoot: dir,
      vault: new CredentialVault(join(dir, 'credentials.enc.json'), 'test'),
      oauth: new PkceSessionStore(),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server_address_missing');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/oauth/start`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { authorizeUrl: string; expiresAt: string };
    const authorization = new URL(payload.authorizeUrl);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(payload).not.toHaveProperty('verifier');
    const callback = `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/oauth/callback?error=access_denied&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`;
    expect((await fetch(callback)).status).toBe(400);
    expect((await fetch(callback)).status).toBe(400);
  });
  it('runs scoped deterministic evaluations and persists evidence without outputs', async () => {
    const base = await start();
    const datasetResponse = await fetch(`${base}/api/v1/evaluations/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke evaluations' }),
    });
    expect(datasetResponse.status).toBe(201);
    const dataset = (await datasetResponse.json()) as { id: string };
    const caseResponse = await fetch(`${base}/api/v1/evaluations/cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        datasetId: dataset.id,
        name: 'Exact response',
        expected: { answer: 'ok' },
        graders: ['exact-match'],
      }),
    });
    expect(caseResponse.status).toBe(201);
    const evaluationCase = (await caseResponse.json()) as { id: string };
    const runResponse = await fetch(`${base}/api/v1/evaluations/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        datasetId: dataset.id,
        outputs: { [evaluationCase.id]: { answer: 'ok' } },
      }),
    });
    expect(runResponse.status).toBe(201);
    const run = (await runResponse.json()) as {
      status: string;
      results: Array<{ passed: boolean; evidence: string[] }>;
    };
    expect(run.status).toBe('completed');
    expect(run.results[0]).toMatchObject({ passed: true });
    expect(JSON.stringify(run)).not.toContain('apiKey');
    expect((await fetch(`${base}/api/v1/evaluations/runs`)).status).toBe(200);
  });
  it('replays a run create response for the same idempotency key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-api-'));
    const store = createStore(dir);
    const project = entity({
      kind: 'project',
      ownerId: 'local-user',
      scope: 'workspace',
      workspaceId: 'workspace',
      name: 'P',
      slug: 'p',
      archived: false,
    }) as Project;
    const environment = entity({
      kind: 'environment',
      ownerId: 'local-user',
      scope: project.id,
      projectId: project.id,
      name: 'dev',
      network: 'blocked' as const,
      persistent: false,
      protected: false,
    }) as Environment;
    const agent = entity({
      kind: 'agent',
      ownerId: 'local-user',
      scope: project.id,
      projectId: project.id,
      environmentId: environment.id,
      status: 'idle' as const,
      profile: { mode: 'supervised' } as never,
    }) as Agent;
    const task = entity({
      kind: 'task',
      ownerId: 'local-user',
      scope: project.id,
      projectId: project.id,
      environmentId: environment.id,
      title: 't',
      description: 't',
      acceptanceCriteria: [],
      status: 'ready' as const,
      priority: 1,
      dependencyIds: [],
      labels: [],
    }) as Task;
    await store.insert(project);
    await store.insert(environment);
    await store.insert(agent);
    await store.insert(task);
    let creates = 0;
    const run = entity({
      kind: 'run',
      ownerId: 'local-user',
      scope: project.id,
      projectId: project.id,
      environmentId: environment.id,
      agentId: agent.id,
      taskId: task.id,
      mode: 'supervised' as const,
      status: 'queued' as const,
      stepCount: 0,
      maxSteps: 1,
      cancelRequested: false,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
    }) as Run;
    const orchestrator = Object.assign(new EventEmitter(), {
      createRun: async () => {
        creates += 1;
        return run;
      },
      start: async () => undefined,
    }) as unknown as Orchestrator;
    const server = createApi({
      store,
      orchestrator,
      uiRoot: dir,
      vault: new CredentialVault(join(dir, 'credentials.enc.json'), 'test'),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server_address_missing');
    const base = `http://127.0.0.1:${address.port}`;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'same-run' },
      body: JSON.stringify({ projectId: project.id, agentId: agent.id, taskId: task.id }),
    };
    const first = await fetch(`${base}/api/v1/runs`, init);
    const second = await fetch(`${base}/api/v1/runs`, init);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ id: run.id });
    expect(creates).toBe(1);
  });
});
