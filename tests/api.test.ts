import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { entity, Agent, Environment, Project, Run, Task } from '../src/types.js';

const servers: Array<ReturnType<typeof createApi>> = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.BOT_BUFFET_AUTH_MODE;
  delete process.env.BOT_BUFFET_API_TOKEN;
});

async function start(auth = false) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-api-'));
  const server = createApi({
    store: createStore(dir),
    orchestrator: new EventEmitter() as unknown as Orchestrator,
    uiRoot: dir,
    vault: new CredentialVault(join(dir, 'credentials.enc.json'), 'test'),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_missing');
  if (auth) {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    process.env.BOT_BUFFET_API_TOKEN = 'test-token';
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('API boundary controls', () => {
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
  it('requires production bearer auth before API access', async () => {
    const base = await start(true);
    const response = await fetch(`${base}/api/v1/bootstrap`);
    expect(response.status).toBe(401);
    const authorized = await fetch(`${base}/api/v1/bootstrap`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(authorized.status).toBe(200);
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
