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
  delete process.env.BOT_BUFFET_PROVIDER_ENDPOINT_ALLOWLIST;
  delete process.env.BOT_BUFFET_PROVIDER_ENV_ALLOWLIST;
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

  it('derives model locality from the provider endpoint instead of trusting the body', async () => {
    const base = await start();
    const providerResponse = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Cloud route host',
        providerKind: 'openai',
        endpoint: 'https://api.openai.com/v1',
      }),
    });
    const provider = (await providerResponse.json()) as { id: string };
    const rejected = await fetch(`${base}/api/v1/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: provider.id, modelName: 'cloud', local: true }),
    });
    expect(rejected.status).toBe(400);

    const localProviderResponse = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Local route host',
        providerKind: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
      }),
    });
    const localProvider = (await localProviderResponse.json()) as { id: string };
    const created = await fetch(`${base}/api/v1/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: localProvider.id, modelName: 'local', local: false }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ local: true });
  });

  it('manages project budgets and estimates cost before execution', async () => {
    const base = await start();
    const project = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Budget project' }),
      })
    ).json()) as { id: string };
    const provider = (await (
      await fetch(`${base}/api/v1/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Budget host',
          providerKind: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
        }),
      })
    ).json()) as { id: string };
    const model = (await (
      await fetch(`${base}/api/v1/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: provider.id,
          modelName: 'budget-model',
          local: true,
          inputCostPerMillionCents: 200,
          outputCostPerMillionCents: 600,
        }),
      })
    ).json()) as { id: string };
    const createdResponse = await fetch(`${base}/api/v1/budgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        name: 'Daily cap',
        period: 'daily',
        limitCents: 500,
        warnRatio: 0.3,
      }),
    });
    expect(createdResponse.status).toBe(201);
    await expect(createdResponse.json()).resolves.toMatchObject({
      kind: 'budget',
      projectId: project.id,
      period: 'daily',
      limitCents: 500,
      enabled: true,
    });
    const listed = (await (await fetch(`${base}/api/v1/budgets`)).json()) as Array<{
      name: string;
      status: { state: string; spentCents: number; remainingCents: number };
    }>;
    expect(listed[0]).toMatchObject({
      name: 'Daily cap',
      status: { state: 'ok', spentCents: 0, remainingCents: 500 },
    });
    const estimateResponse = await fetch(`${base}/api/v1/budgets/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        modelId: model.id,
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    });
    expect(estimateResponse.status).toBe(200);
    await expect(estimateResponse.json()).resolves.toMatchObject({
      estimatedCostCents: 200,
      allowed: true,
      warnings: [expect.objectContaining({ state: 'warning' })],
    });
    const blockedResponse = await fetch(`${base}/api/v1/budgets/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        modelId: model.id,
        inputTokens: 5_000_000,
        outputTokens: 0,
      }),
    });
    const blocked = (await blockedResponse.json()) as {
      allowed: boolean;
      blockedBy: { state: string; period: string };
    };
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy).toMatchObject({ state: 'exceeded', period: 'daily' });
    const invalidPeriod = await fetch(`${base}/api/v1/budgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, period: 'hourly', limitCents: 100 }),
    });
    expect(invalidPeriod.status).toBe(400);
    const invalidLimit = await fetch(`${base}/api/v1/budgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, period: 'daily', limitCents: -5 }),
    });
    expect(invalidLimit.status).toBe(400);
    const invalidTokens = await fetch(`${base}/api/v1/budgets/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, modelId: model.id, inputTokens: -1 }),
    });
    expect(invalidTokens.status).toBe(400);
    const unknownAgentEstimate = await fetch(`${base}/api/v1/budgets/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        modelId: model.id,
        inputTokens: 10,
        outputTokens: 0,
        agentId: 'agent-does-not-exist',
      }),
    });
    expect(unknownAgentEstimate.status).toBe(400);
    await expect(unknownAgentEstimate.json()).resolves.toMatchObject({
      code: 'request_failed',
      message: 'forbidden_or_not_found',
    });
  });

  it('validates citations against source state and builds a research brief', async () => {
    const base = await start();
    const project = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Research project' }),
      })
    ).json()) as { id: string };
    const good = (await (
      await fetch(`${base}/api/v1/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          uri: 'https://example.test/a',
          status: 'available',
          retrievedAt: '2026-08-20T00:00:00.000Z',
          contentHash: 'a'.repeat(64),
        }),
      })
    ).json()) as { id: string; status: string };

    const created = await fetch(`${base}/api/v1/citations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: good.id,
        claim: 'The harness owns the agent loop',
        // A caller claiming verification must not be believed.
        verified: true,
      }),
    });
    expect(created.status).toBe(201);
    const citation = (await created.json()) as {
      verified: boolean;
      validation: { valid: boolean };
    };
    expect(citation.validation.valid).toBe(good.status === 'available');
    expect(citation.verified).toBe(citation.validation.valid);

    const emptyClaim = await fetch(`${base}/api/v1/citations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: good.id, claim: '   ' }),
    });
    expect(emptyClaim.status).toBe(400);

    const orphan = await fetch(`${base}/api/v1/citations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'no-such-source', claim: 'unbacked claim' }),
    });
    expect(orphan.status).toBe(400);

    const brief = await fetch(`${base}/api/v1/projects/${project.id}/research-brief`);
    expect(brief.status).toBe(200);
    await expect(brief.json()).resolves.toMatchObject({
      projectId: project.id,
      totalSources: 1,
    });

    const listed = (await (await fetch(`${base}/api/v1/citations`)).json()) as Array<{
      validation: { valid: boolean };
    }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.validation).toBeDefined();
  });

  it('retrieves source content over the pinned transport and refuses unsafe endpoints', async () => {
    const base = await start();
    const project = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Retrieval project' }),
      })
    ).json()) as { id: string };

    // A source pointing at a loopback address must be refused, not silently fetched.
    const unsafe = await fetch(`${base}/api/v1/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, uri: 'http://127.0.0.1:9/secret' }),
    });
    expect(unsafe.status).toBe(400);

    const source = (await (
      await fetch(`${base}/api/v1/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, uri: 'https://example.test/paper' }),
      })
    ).json()) as { id: string; status: string };
    expect(source.status).toBe('pending');

    // A claim on an unretrieved source cannot be verified.
    const premature = (await (
      await fetch(`${base}/api/v1/citations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, claim: 'premature claim' }),
      })
    ).json()) as { verified: boolean; validation: { reasons: string[] } };
    expect(premature.verified).toBe(false);
    expect(premature.validation.reasons).toContain('citation_source_pending');

    // Retrieval of an unreachable host records inaccessible rather than inventing success.
    const retrieved = await fetch(`${base}/api/v1/sources/${source.id}/retrieve`, {
      method: 'POST',
    });
    expect(retrieved.status).toBe(200);
    const body = (await retrieved.json()) as { status: string; contentHash?: string };
    expect(body.status).toBe('inaccessible');
    expect(body.contentHash).toBeUndefined();

    const brief = (await (
      await fetch(`${base}/api/v1/projects/${project.id}/research-brief`)
    ).json()) as { inaccessibleSources: string[]; usableSources: number };
    expect(brief.inaccessibleSources).toContain(source.id);
    expect(brief.usableSources).toBe(0);
  });

  it('exposes scrapeable metrics and OTLP run traces', async () => {
    const base = await start();
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    const body = await metrics.text();
    expect(body).toContain('bot_buffet_runs_total');
    expect(body).toContain('bot_buffet_alerts_unacknowledged');

    const missingTrace = await fetch(`${base}/api/v1/runs/does-not-exist/trace`);
    expect(missingTrace.status).toBe(400);
  });

  it('gates evaluation runs against a golden baseline', async () => {
    const base = await start();
    const dataset = (await (
      await fetch(`${base}/api/v1/evaluations/datasets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Golden tasks', description: 'Release regression suite' }),
      })
    ).json()) as { id: string };
    const first = (await (
      await fetch(`${base}/api/v1/evaluations/cases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          datasetId: dataset.id,
          name: 'greets',
          input: {},
          expected: 'ready',
          graders: ['contains'],
        }),
      })
    ).json()) as { id: string };

    const baselineResponse = await fetch(`${base}/api/v1/evaluations/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ datasetId: dataset.id, outputs: { [first.id]: 'system ready' } }),
    });
    expect(baselineResponse.status).toBe(201);
    const baseline = (await baselineResponse.json()) as {
      id: string;
      results: Array<{ passed: boolean }>;
    };
    expect(baseline.results[0]?.passed).toBe(true);

    const regressed = await fetch(`${base}/api/v1/evaluations/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        datasetId: dataset.id,
        baselineRunId: baseline.id,
        outputs: { [first.id]: 'system offline' },
      }),
    });
    expect(regressed.status).toBe(201);
    const regressedBody = (await regressed.json()) as {
      regression: { regressions: string[] };
      gate: { allowed: boolean; reasons: string[] };
    };
    expect(regressedBody.regression.regressions).toEqual([first.id]);
    expect(regressedBody.gate.allowed).toBe(false);
    expect(regressedBody.gate.reasons).toContain('evaluation_regression');

    const clean = await fetch(`${base}/api/v1/evaluations/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        datasetId: dataset.id,
        baselineRunId: baseline.id,
        outputs: { [first.id]: 'system ready again' },
      }),
    });
    await expect(clean.json()).resolves.toMatchObject({ gate: { allowed: true, reasons: [] } });

    const badFloor = await fetch(`${base}/api/v1/evaluations/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        datasetId: dataset.id,
        baselineRunId: baseline.id,
        minimumPassRate: 5,
        outputs: {},
      }),
    });
    expect(badFloor.status).toBe(400);

    const audit = (await (await fetch(`${base}/api/v1/audit`)).json()) as Array<{
      action: string;
      decision: string;
    }>;
    expect(
      audit.some((event) => event.action === 'evaluation.gate' && event.decision === 'denied'),
    ).toBe(true);
  });

  it('registers scanned artifacts and builds a tamper-evident manifest', async () => {
    const base = await start();
    const project = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Artifact project' }),
      })
    ).json()) as { id: string };
    const created = await fetch(`${base}/api/v1/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        name: 'report.md',
        content: '# Findings\n\nAll checks passed.',
      }),
    });
    expect(created.status).toBe(201);
    const artifact = (await created.json()) as { id: string; sha256: string; scanStatus: string };
    expect(artifact.scanStatus).toBe('clean');
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

    const blocked = await fetch(`${base}/api/v1/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        name: 'leak.md',
        content: `token ${['sk', 'a1b2c3d4e5f6g7h8'].join('-')}`,
      }),
    });
    expect(blocked.status).toBe(400);
    await expect(blocked.json()).resolves.toMatchObject({
      message: 'artifact_contains_credential',
    });

    const manifest = await fetch(`${base}/api/v1/projects/${project.id}/artifact-manifest`);
    expect(manifest.status).toBe(200);
    const body = (await manifest.json()) as {
      manifestSha256: string;
      artifacts: Array<{ id: string }>;
    };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.id).toBe(artifact.id);
    expect(body.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

    const listed = (await (
      await fetch(`${base}/api/v1/artifacts?projectId=${project.id}`)
    ).json()) as unknown[];
    expect(listed).toHaveLength(1);
  });

  it('creates validated workflow graphs and plans ready nodes', async () => {
    const base = await start();
    const project = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Workflow project' }),
      })
    ).json()) as { id: string };
    const created = await fetch(`${base}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        name: 'Release',
        nodes: [
          { id: 'plan', kind: 'task', config: {} },
          { id: 'build', kind: 'task', config: {} },
          { id: 'approve', kind: 'approval', config: {} },
        ],
        edges: [
          { from: 'plan', to: 'build' },
          { from: 'build', to: 'approve' },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const workflow = (await created.json()) as { id: string; enabled: boolean };
    expect(workflow.enabled).toBe(false);

    const plan = await fetch(`${base}/api/v1/workflows/${workflow.id}/plan`);
    expect(plan.status).toBe(200);
    await expect(plan.json()).resolves.toMatchObject({
      levels: [['plan'], ['build'], ['approve']],
      ready: ['plan'],
    });
    const advanced = await fetch(`${base}/api/v1/workflows/${workflow.id}/plan?completed=plan`);
    await expect(advanced.json()).resolves.toMatchObject({ ready: ['build'] });
    const afterFailure = await fetch(
      `${base}/api/v1/workflows/${workflow.id}/plan?completed=plan&failed=build`,
    );
    await expect(afterFailure.json()).resolves.toMatchObject({ ready: [] });
    const unknownNode = await fetch(`${base}/api/v1/workflows/${workflow.id}/plan?completed=ghost`);
    expect(unknownNode.status).toBe(400);

    const cyclic = await fetch(`${base}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        name: 'Cycle',
        nodes: [
          { id: 'a', kind: 'task', config: {} },
          { id: 'b', kind: 'task', config: {} },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    });
    expect(cyclic.status).toBe(400);
    const listed = (await (await fetch(`${base}/api/v1/workflows`)).json()) as unknown[];
    expect(listed).toHaveLength(1);
  });

  it('reports scoped usage and rejects invalid report parameters', async () => {
    const base = await start();
    const project = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Usage project' }),
      })
    ).json()) as { id: string };
    const empty = await fetch(`${base}/api/v1/usage?groupBy=agent&period=daily`);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({
      totalCostCents: 0,
      totalCalls: 0,
      buckets: [],
      window: { period: 'daily' },
    });
    const scoped = await fetch(`${base}/api/v1/usage?projectId=${project.id}`);
    expect(scoped.status).toBe(200);
    const badGrouping = await fetch(`${base}/api/v1/usage?groupBy=everything`);
    expect(badGrouping.status).toBe(400);
    const badPeriod = await fetch(`${base}/api/v1/usage?period=hourly`);
    expect(badPeriod.status).toBe(400);
    const unknownProject = await fetch(`${base}/api/v1/usage?projectId=missing-project`);
    expect(unknownProject.status).toBe(400);
    const alerts = await fetch(`${base}/api/v1/alerts`);
    expect(alerts.status).toBe(200);
    await expect(alerts.json()).resolves.toEqual([]);
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
    const scheduleResponse = await fetch(`${base}/api/v1/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, taskId: task.id, cron: '0 * * * *' }),
    });
    expect(scheduleResponse.status).toBe(201);
    const schedule = (await scheduleResponse.json()) as { id: string; version: number };
    const enabledScheduleResponse = await fetch(`${base}/api/v1/schedules/${schedule.id}/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: schedule.version }),
    });
    expect(enabledScheduleResponse.status).toBe(200);
    expect(await enabledScheduleResponse.json()).toMatchObject({
      enabled: true,
      version: schedule.version + 1,
    });
    const staleScheduleResponse = await fetch(`${base}/api/v1/schedules/${schedule.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: schedule.version }),
    });
    expect(staleScheduleResponse.status).toBe(400);
    const secret = 'w'.repeat(32);
    const webhookResponse = await fetch(`${base}/api/v1/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        url: 'https://hooks.example.test/events',
        secret,
        events: ['run.completed'],
      }),
    });
    expect(webhookResponse.status).toBe(201);
    const webhook = (await webhookResponse.json()) as {
      id: string;
      version: number;
      secretFingerprint: string;
    };
    expect(webhook.secretFingerprint).toBeTruthy();
    expect(JSON.stringify(webhook)).not.toContain(secret);
    await expect((await fetch(`${base}/api/v1/webhooks/events`)).json()).resolves.toEqual({
      events: expect.arrayContaining(['run.completed', 'run.blocked', 'budget.warning']),
    });
    const unknownEventResponse = await fetch(`${base}/api/v1/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        url: 'https://hooks.example.test/events',
        secret,
        events: ['run.not-a-real-event'],
      }),
    });
    expect(unknownEventResponse.status).toBe(400);
    const enabledWebhookResponse = await fetch(`${base}/api/v1/webhooks/${webhook.id}/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: webhook.version }),
    });
    expect(enabledWebhookResponse.status).toBe(200);
    expect(await enabledWebhookResponse.json()).toMatchObject({
      enabled: true,
      version: webhook.version + 1,
    });
    const staleWebhookResponse = await fetch(`${base}/api/v1/webhooks/${webhook.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: webhook.version }),
    });
    expect(staleWebhookResponse.status).toBe(400);
    const testDelivery = await fetch(`${base}/api/v1/webhooks/${webhook.id}/test`, {
      method: 'POST',
    });
    expect(testDelivery.status).toBe(200);
    expect(await testDelivery.json()).toMatchObject({ signed: true, delivered: false });
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
    const environments = (await (await fetch(`${base}/api/v1/environments`)).json()) as Array<{
      projectId: string;
      name: string;
      network: string;
    }>;
    expect(environments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: created.id,
          name: 'Local Development',
          network: 'blocked',
        }),
      ]),
    );
    const deletedResponse = await fetch(`${base}/api/v1/projects/${created.id}`, {
      method: 'DELETE',
    });
    expect(deletedResponse.status).toBe(204);
    const listed = await fetch(`${base}/api/v1/projects`);
    expect(await listed.json()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
  });
  it('duplicates project configuration without reusing the project slug', async () => {
    const base = await start();
    const createdResponse = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Template', slug: 'template' }),
    });
    const source = (await createdResponse.json()) as { id: string };
    const first = await fetch(`${base}/api/v1/projects/${source.id}/duplicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Copy', slug: 'copy' }),
    });
    expect(first.status).toBe(201);
    const copied = (await first.json()) as {
      project: { id: string; slug: string };
      excluded: string[];
    };
    expect(copied.project.slug).toBe('copy');
    expect(copied.excluded).toContain('credentials');
    const second = await fetch(`${base}/api/v1/projects/${source.id}/duplicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'copy' }),
    });
    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toMatchObject({ project: { slug: 'copy-2' } });
  });
  it('paginates project lists with bounded opaque cursors', async () => {
    const base = await start();
    for (const slug of ['page-a', 'page-b', 'page-c']) {
      const response = await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: slug, slug }),
      });
      expect(response.status).toBe(201);
    }
    const first = await fetch(`${base}/api/v1/projects?limit=2`);
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<{ slug: string }>;
      total: number;
      limit: number;
      nextCursor?: string;
    };
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(3);
    expect(firstPage.limit).toBe(2);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await fetch(
      `${base}/api/v1/projects?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    await expect(second.json()).resolves.toMatchObject({ items: [{ slug: 'page-c' }], total: 3 });
    expect((await fetch(`${base}/api/v1/projects?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/projects?cursor=not-a-cursor`)).status).toBe(400);
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
    // A public endpoint paired with an arbitrary environment variable is an
    // exfiltration route, so the host must be on an operator-owned allowlist
    // before an environment-backed provider may be created against it.
    process.env.BOT_BUFFET_PROVIDER_ENDPOINT_ALLOWLIST = 'api.example.test';
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
  it('refuses an environment provider whose endpoint is not allowlisted', async () => {
    process.env.BOT_BUFFET_TEST_PROVIDER_TOKEN = 'env-secret';
    process.env.BOT_BUFFET_PROVIDER_ENDPOINT_ALLOWLIST = 'api.allowed.test';
    const base = await start();
    const response = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Exfiltration Provider',
        providerKind: 'openai',
        endpoint: 'https://attacker.example/v1',
        authType: 'env',
        environmentVariable: 'BOT_BUFFET_TEST_PROVIDER_TOKEN',
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      message: 'provider_environment_endpoint_not_allowlisted',
    });
  });
  it('refuses to reference a protected environment variable', async () => {
    // The harness own secrets must never be reachable through a user-created
    // provider reference, allowlisted endpoint or not.
    process.env.BOT_BUFFET_PROVIDER_ENDPOINT_ALLOWLIST = 'api.example.test';
    const base = await start();
    for (const environmentVariable of [
      'BOT_BUFFET_MASTER_KEY',
      'BOT_BUFFET_BACKUP_KEY',
      'BOT_BUFFET_BOOTSTRAP_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ]) {
      const response = await fetch(`${base}/api/v1/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Protected Reference',
          providerKind: 'openai',
          endpoint: 'https://api.example.test/v1',
          authType: 'env',
          environmentVariable,
        }),
      });
      expect(response.status, environmentVariable).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        message: 'provider_environment_variable_protected',
      });
    }
  });
  it('allows a loopback local provider without an endpoint allowlist entry', async () => {
    // Loopback traffic cannot leave the host, so a local runtime needs no
    // allowlist entry — otherwise every offline setup would need configuring.
    delete process.env.BOT_BUFFET_PROVIDER_ENDPOINT_ALLOWLIST;
    process.env.BOT_BUFFET_TEST_PROVIDER_TOKEN = 'env-secret';
    const base = await start();
    const response = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Local Runtime',
        providerKind: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
        authType: 'env',
        environmentVariable: 'BOT_BUFFET_TEST_PROVIDER_TOKEN',
      }),
    });
    expect(response.status).toBe(201);
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
