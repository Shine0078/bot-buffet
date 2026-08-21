import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';

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
});
