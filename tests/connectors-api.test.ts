import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { AuditEvent, Plugin } from '../src/types.js';

/**
 * Evidence for the acceptance criterion that the named integrations are
 * optional and permission-scoped: installing one grants nothing, and the
 * harness keeps working with none of them installed.
 */

const servers: Array<ReturnType<typeof createApi>> = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-connectors-'));
  const store = createStore(dir);
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
  return { base: `http://127.0.0.1:${address.port}`, store };
}

describe('connector API', () => {
  it('lists the catalog with nothing installed on a fresh instance', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/v1/connectors`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connectors: Array<{ id: string; installed: boolean; allowedHosts: string[] }>;
    };
    expect(body.connectors.length).toBeGreaterThanOrEqual(8);
    // Optional means optional: a new workspace has none of them.
    expect(body.connectors.every((connector) => connector.installed === false)).toBe(true);
  });

  it('keeps the harness fully usable with no connector installed', async () => {
    const { base } = await start();
    // The core control plane must not depend on any integration.
    for (const path of ['/healthz', '/readyz', '/api/v1/projects', '/api/v1/bootstrap']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
    }
  });

  it('installs a connector as a disabled, allowlisted plugin that grants nothing', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/v1/connectors/github/install`, { method: 'POST' });
    expect(response.status).toBe(201);
    const plugin = (await response.json()) as Plugin;
    expect(plugin.source).toBe('connector:github');
    expect(plugin.enabled).toBe(false);
    expect(plugin.workspaceEnabled).toBe(false);
    expect(plugin.projectIds).toEqual([]);
    expect(plugin.agentIds).toEqual([]);
    expect(plugin.network).toBe('allowlist');
    expect(plugin.permissions).toEqual(['github:repo', 'github:read:org']);
  });

  it('reports a connector as installed once it has been', async () => {
    const { base } = await start();
    await fetch(`${base}/api/v1/connectors/figma/install`, { method: 'POST' });
    const body = (await (await fetch(`${base}/api/v1/connectors`)).json()) as {
      connectors: Array<{ id: string; installed: boolean }>;
    };
    expect(body.connectors.find((connector) => connector.id === 'figma')?.installed).toBe(true);
    expect(body.connectors.find((connector) => connector.id === 'asana')?.installed).toBe(false);
  });

  it('is idempotent, returning the existing plugin rather than a duplicate', async () => {
    const { base, store } = await start();
    const first = (await (
      await fetch(`${base}/api/v1/connectors/wolfram/install`, { method: 'POST' })
    ).json()) as Plugin;
    const second = await fetch(`${base}/api/v1/connectors/wolfram/install`, { method: 'POST' });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Plugin).id).toBe(first.id);

    const plugins = await store.list<Plugin>(
      (x) => x.kind === 'plugin' && (x as Plugin).source === 'connector:wolfram',
    );
    expect(plugins).toHaveLength(1);
  });

  it('audits the install with the requested scopes and reachable hosts', async () => {
    const { base, store } = await start();
    await fetch(`${base}/api/v1/connectors/cloudflare/install`, { method: 'POST' });
    const events = await store.list<AuditEvent>(
      (x) => x.kind === 'audit-event' && (x as AuditEvent).action === 'connector.install',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      connectorId: 'cloudflare',
      allowedHosts: ['api.cloudflare.com'],
      enabled: false,
    });
    // The audit chain must still verify after an install.
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });

  it('rejects an unknown connector', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/v1/connectors/not-a-connector/install`, {
      method: 'POST',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('never returns credential material in the catalog', async () => {
    const { base } = await start();
    const text = await (await fetch(`${base}/api/v1/connectors`)).text();
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{12,}/);
    expect(text).not.toMatch(/Bearer\s+\S+/);
  });
});
