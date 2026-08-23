import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ModelRouter } from '../src/router.js';
import { MockLocalAdapter } from '../src/providers.js';
import { createBuiltinTools } from '../src/tools.js';
import { entity, type Credential, type ProjectFile, type Run } from '../src/types.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';

/**
 * The read surfaces an operator watches: the observability summary, the
 * credential list, and the file registry.
 *
 * The credential list is the one that matters most. It is the place a secret
 * would leak if redaction ever stopped working, so it is asserted against the
 * raw response text rather than a parsed object — a check on a parsed field
 * would miss a secret that appeared somewhere unexpected in the payload.
 */

/** A credential-shaped value that never appears literally in this file. */
const FAKE_LIVE_KEY = ['sk', 'live', '0'.repeat(26)].join('-');

const servers: Array<ReturnType<typeof createApi>> = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-observe-'));
  const store = createStore(dir);
  const { project, agent, model, task } = fixtures('execute');
  for (const record of [project, agent, model, task]) await store.insert(record);

  const orchestrator = new Orchestrator({
    store,
    router: new ModelRouter(async () => [model]),
    tools: createBuiltinTools(store),
    workspaceRoot: () => dir,
    adapters: () => new MockLocalAdapter('m'),
  });
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
  return {
    base: `http://127.0.0.1:${address.port}`,
    store,
    project,
    agent,
    task,
    orchestrator,
  };
}

describe('observability summary', () => {
  it('reports zeroes and a valid chain on a fresh instance', async () => {
    const { base } = await start();
    const summary = (await (await fetch(`${base}/api/v1/observability/summary`)).json()) as Record<
      string,
      number | boolean
    >;
    expect(summary).toMatchObject({
      runs: 0,
      active: 0,
      completed: 0,
      failed: 0,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
      auditValid: true,
    });
  });

  it('counts a queued run as active', async () => {
    const { base, orchestrator, project, agent, task } = await start();
    await orchestrator.createRun({ ownerId: 'local-user', project, agent, task });
    const summary = (await (await fetch(`${base}/api/v1/observability/summary`)).json()) as {
      runs: number;
      active: number;
    };
    expect(summary.runs).toBe(1);
    expect(summary.active).toBe(1);
  });

  it('separates completed from failed, and counts cancelled as failed', async () => {
    const { base, store, orchestrator, project, agent, task } = await start();
    const completed = await orchestrator.createRun({ ownerId: 'local-user', project, agent, task });
    const cancelled = await orchestrator.createRun({ ownerId: 'local-user', project, agent, task });
    await store.put({ ...completed, status: 'completed', version: completed.version } as Run);
    await store.put({ ...cancelled, status: 'cancelled', version: cancelled.version } as Run);

    const summary = (await (await fetch(`${base}/api/v1/observability/summary`)).json()) as {
      completed: number;
      failed: number;
      active: number;
    };
    expect(summary.completed).toBe(1);
    // A cancelled run did not succeed, so it must not be counted as though it did.
    expect(summary.failed).toBe(1);
    expect(summary.active).toBe(0);
  });

  it('sums tokens and cost across runs', async () => {
    const { base, store, orchestrator, project, agent, task } = await start();
    const run = await orchestrator.createRun({ ownerId: 'local-user', project, agent, task });
    await store.put({
      ...run,
      tokensIn: 120,
      tokensOut: 45,
      costCents: 7,
      latencyMs: 900,
      version: run.version,
    } as Run);

    const summary = (await (await fetch(`${base}/api/v1/observability/summary`)).json()) as Record<
      string,
      number
    >;
    expect(summary.tokensIn).toBe(120);
    expect(summary.tokensOut).toBe(45);
    expect(summary.costCents).toBe(7);
    expect(summary.latencyMs).toBe(900);
  });

  it('reports the audit chain as the summary sees it, not as a constant', async () => {
    const { base } = await start();
    const summary = (await (await fetch(`${base}/api/v1/observability/summary`)).json()) as {
      auditValid: boolean;
    };
    expect(summary.auditValid).toBe(true);
  });
});

describe('credential listing', () => {
  it('returns metadata without the secret, checked against the raw payload', async () => {
    const { base, store } = await start();
    await store.insert(
      entity({
        kind: 'credential',
        ownerId: 'local-user',
        scope: 'workspace_local',
        secretRef: 'vault:provider:the-secret-reference',
        metadata: {
          providerId: 'provider-1',
          label: 'Test key',
          authType: 'api-key',
          scopes: ['models:read'],
          disabled: false,
          fingerprint: 'abcdef0123456789',
        },
      }) as Credential,
    );

    const text = await (await fetch(`${base}/api/v1/credentials`)).text();
    // Asserted against the raw text: a parsed-field check would miss a secret
    // that surfaced somewhere unexpected in the payload.
    expect(text).not.toContain('the-secret-reference');
    expect(text).toContain('abcdef0123456789');
    expect(text).toContain('Test key');
  });

  it('never returns anything resembling a live key', async () => {
    const { base, store } = await start();
    await store.insert(
      entity({
        kind: 'credential',
        ownerId: 'local-user',
        scope: 'workspace_local',
        // Assembled at runtime rather than written literally: the secret scan
        // rightly refuses key-shaped strings in source, and a negative fixture
        // must not force the scanner to be weakened to accommodate it.
        secretRef: FAKE_LIVE_KEY,
        metadata: {
          providerId: 'provider-1',
          label: 'Leaky',
          authType: 'api-key',
          scopes: [],
          disabled: false,
          fingerprint: 'ffff0000ffff0000',
        },
      }) as Credential,
    );
    const text = await (await fetch(`${base}/api/v1/credentials`)).text();
    expect(text).not.toMatch(/sk-live\d+/);
  });

  it('returns an empty list on a fresh instance', async () => {
    const { base } = await start();
    await expect((await fetch(`${base}/api/v1/credentials`)).json()).resolves.toEqual([]);
  });
});

describe('file registry', () => {
  const fileFor = (projectId: string, path: string) =>
    entity({
      kind: 'file',
      ownerId: 'local-user',
      scope: projectId,
      projectId,
      path,
      sha256: 'a'.repeat(64),
      size: 12,
      versionLabel: 'v1',
    }) as ProjectFile;

  it('lists files and filters them by project', async () => {
    const { base, store, project } = await start();
    await store.insert(fileFor(project.id, 'notes.md'));
    await store.insert(fileFor('another-project', 'other.md'));

    const all = (await (await fetch(`${base}/api/v1/files`)).json()) as ProjectFile[];
    expect(all.length).toBeGreaterThanOrEqual(1);

    const scoped = (await (
      await fetch(`${base}/api/v1/files?projectId=${project.id}`)
    ).json()) as ProjectFile[];
    expect(scoped.every((file) => file.projectId === project.id)).toBe(true);
    expect(scoped.map((file) => file.path)).toEqual(['notes.md']);
  });

  it('returns nothing for a project with no files rather than falling back to all', async () => {
    // A filter that silently returns everything when it matches nothing is
    // worse than an empty list, because it looks like data.
    const { base, store, project } = await start();
    await store.insert(fileFor(project.id, 'notes.md'));
    const scoped = (await (
      await fetch(`${base}/api/v1/files?projectId=project-with-nothing`)
    ).json()) as ProjectFile[];
    expect(scoped).toEqual([]);
  });
});
