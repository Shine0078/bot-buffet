import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { entity } from '../src/types.js';
import type { AuditEvent, Credential, Plugin, Workspace } from '../src/types.js';

/**
 * Evidence for the acceptance criterion that the named integrations are
 * optional and permission-scoped: installing one grants nothing, and the
 * harness keeps working with none of them installed.
 */

const servers: Array<ReturnType<typeof createApi>> = [];
const previousAuthMode = process.env.BOT_BUFFET_AUTH_MODE;

afterEach(async () => {
  if (previousAuthMode === undefined) delete process.env.BOT_BUFFET_AUTH_MODE;
  else process.env.BOT_BUFFET_AUTH_MODE = previousAuthMode;
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-connectors-'));
  const store = createStore(dir);
  const vault = new CredentialVault(
    join(dir, 'credentials.enc.json'),
    '12345678901234567890123456789012',
  );
  const server = createApi({
    store,
    orchestrator: new EventEmitter() as unknown as Orchestrator,
    uiRoot: dir,
    vault,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_missing');
  return { base: `http://127.0.0.1:${address.port}`, store, vault };
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

  it('keeps health probes public when production auth is enabled', async () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    const { base } = await start();
    await expect(fetch(`${base}/healthz`)).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${base}/readyz`)).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${base}/api/v1/projects`)).resolves.toMatchObject({ status: 401 });
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

  it('supports scoped plugin activation and agent allowlists with CAS', async () => {
    const { base, store } = await start();
    const workspace = entity({
      kind: 'workspace',
      ownerId: 'local-user',
      scope: 'organization_local',
      organizationId: 'organization_local',
      name: 'Plugin workspace',
      slug: 'plugin-workspace',
      offlineMode: true,
    }) as Workspace;
    await store.insert(workspace);

    const project = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, name: 'Plugin project' }),
      })
    ).json()) as { id: string };
    const agent = (await (
      await fetch(`${base}/api/v1/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      })
    ).json()) as { id: string; version: number };
    const plugin = (await (
      await fetch(`${base}/api/v1/plugins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: workspace.id, name: 'Scoped connector' }),
      })
    ).json()) as { id: string; version: number };

    const assignedProject = await fetch(`${base}/api/v1/plugins/${plugin.id}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetType: 'project',
        targetId: project.id,
        version: plugin.version,
      }),
    });
    expect(assignedProject.status).toBe(200);
    const projectGrant = (await assignedProject.json()) as {
      version: number;
      projectIds: string[];
      workspaceEnabled: boolean;
    };
    expect(projectGrant).toMatchObject({
      version: 2,
      projectIds: [project.id],
      workspaceEnabled: false,
    });

    const enabled = await fetch(`${base}/api/v1/plugins/${plugin.id}/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: projectGrant.version }),
    });
    expect(enabled.status).toBe(200);
    const enabledPlugin = (await enabled.json()) as { version: number; enabled: boolean };
    expect(enabledPlugin).toMatchObject({ version: 3, enabled: true });

    await expect(
      fetch(`${base}/api/v1/agents/${agent.id}/plugins`).then((response) => response.json()),
    ).resolves.toEqual([expect.objectContaining({ id: plugin.id })]);

    const restricted = await fetch(`${base}/api/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: agent.version,
        profile: { allowedPluginIds: ['different-plugin'] },
      }),
    });
    expect(restricted.status).toBe(200);
    const restrictedAgent = (await restricted.json()) as { version: number };
    await expect(
      fetch(`${base}/api/v1/agents/${agent.id}/plugins`).then((response) => response.json()),
    ).resolves.toEqual([]);

    const reopened = await fetch(`${base}/api/v1/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: restrictedAgent.version,
        profile: { allowedPluginIds: [plugin.id] },
      }),
    });
    expect(reopened.status).toBe(200);
    await expect(
      fetch(`${base}/api/v1/agents/${agent.id}/plugins`).then((response) => response.json()),
    ).resolves.toEqual([expect.objectContaining({ id: plugin.id })]);

    const assignedAgent = await fetch(`${base}/api/v1/plugins/${plugin.id}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetType: 'agent',
        targetId: agent.id,
        version: enabledPlugin.version,
      }),
    });
    expect(assignedAgent.status).toBe(200);
    const agentGrant = (await assignedAgent.json()) as { version: number; agentIds: string[] };
    expect(agentGrant).toMatchObject({ version: 4, agentIds: [agent.id] });

    const otherWorkspace = entity({
      kind: 'workspace',
      ownerId: 'local-user',
      scope: 'organization_local',
      organizationId: 'organization_local',
      name: 'Other workspace',
      slug: 'other-workspace',
      offlineMode: true,
    }) as Workspace;
    await store.insert(otherWorkspace);
    const otherProject = (await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: otherWorkspace.id, name: 'Other project' }),
      })
    ).json()) as { id: string };
    const mismatch = await fetch(`${base}/api/v1/plugins/${plugin.id}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetType: 'project',
        targetId: otherProject.id,
        version: agentGrant.version,
      }),
    });
    expect(mismatch.status).toBe(400);

    const stale = await fetch(`${base}/api/v1/plugins/${plugin.id}/unassign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetType: 'project',
        targetId: project.id,
        version: enabledPlugin.version,
      }),
    });
    expect(stale.status).toBe(400);
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

  it('supports dependency and permission review plus encrypted plugin auth setup', async () => {
    const { base, store, vault } = await start();
    const plugin = (await (
      await fetch(`${base}/api/v1/plugins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Auth plugin', version: '2.0.0' }),
      })
    ).json()) as Plugin;

    await expect(fetch(`${base}/api/v1/plugins/${plugin.id}/dependencies`)).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      fetch(`${base}/api/v1/plugins/${plugin.id}/permissions`).then((response) => response.json()),
    ).resolves.toMatchObject({
      pluginId: plugin.id,
      permissions: [],
      network: 'blocked',
    });

    const configured = await fetch(`${base}/api/v1/plugins/${plugin.id}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: plugin.version,
        authType: 'api-key',
        secret: 'plugin-secret',
      }),
    });
    expect(configured.status).toBe(200);
    const configuredText = await configured.text();
    expect(configuredText).not.toContain('plugin-secret');
    const configuredBody = JSON.parse(configuredText) as {
      plugin: Plugin;
      credential: { id: string; metadata: { authType: string; fingerprint: string } };
    };
    expect(configuredBody.plugin.credentialId).toBe(configuredBody.credential.id);
    expect(configuredBody.credential.metadata.authType).toBe('api-key');
    expect(configuredBody.credential.metadata.fingerprint).toHaveLength(16);
    expect(vault.getSync(`plugin:${plugin.id}`)).toBe('plugin-secret');

    const credentials = await store.list<Credential>(
      (value) => value.kind === 'credential' && value.scope === plugin.scope,
    );
    expect(credentials).toHaveLength(1);
    expect(JSON.stringify(credentials[0])).not.toContain('plugin-secret');

    const reviewed = await (await fetch(`${base}/api/v1/plugins/${plugin.id}/auth`)).json();
    expect(reviewed).toMatchObject({
      pluginId: plugin.id,
      configured: true,
      credential: { id: configuredBody.credential.id },
    });

    const revoked = await fetch(`${base}/api/v1/plugins/${plugin.id}/auth`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: configuredBody.plugin.version }),
    });
    expect(revoked.status).toBe(200);
    const revokedPlugin = (await revoked.json()) as Plugin;
    expect(revokedPlugin.credentialId).toBeUndefined();
    expect(vault.getSync(`plugin:${plugin.id}`)).toBeUndefined();
    await expect(
      store.list<Credential>(
        (value) => value.kind === 'credential' && value.scope === plugin.scope,
      ),
    ).resolves.toHaveLength(0);
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });

  it('revokes plugin credentials during uninstall', async () => {
    const { base, store, vault } = await start();
    const plugin = (await (
      await fetch(`${base}/api/v1/plugins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Cleanup plugin' }),
      })
    ).json()) as Plugin;
    const configured = (await (
      await fetch(`${base}/api/v1/plugins/${plugin.id}/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: plugin.version, secret: 'cleanup-secret' }),
      })
    ).json()) as { plugin: Plugin; credential: { id: string } };

    const deleted = await fetch(`${base}/api/v1/plugins/${plugin.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: configured.plugin.version }),
    });
    expect(deleted.status).toBe(204);
    expect(vault.getSync(`plugin:${plugin.id}`)).toBeUndefined();
    await expect(store.get<Credential>(configured.credential.id)).resolves.toBeUndefined();
    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  });

  it('rejects stale update and uninstall commands without mutating the plugin', async () => {
    const { base, store } = await start();
    const plugin = (await (
      await fetch(`${base}/api/v1/plugins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'CAS plugin' }),
      })
    ).json()) as Plugin;

    const staleUpdate = await fetch(`${base}/api/v1/plugins/${plugin.id}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: plugin.version + 1,
        releaseVersion: '2.0.0',
        integritySha256: 'b'.repeat(64),
      }),
    });
    expect(staleUpdate.status).toBe(400);
    await expect(store.get<Plugin>(plugin.id)).resolves.toMatchObject({
      releaseVersion: plugin.releaseVersion,
      version: plugin.version,
    });

    const staleDelete = await fetch(`${base}/api/v1/plugins/${plugin.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: plugin.version + 1 }),
    });
    expect(staleDelete.status).toBe(400);
    await expect(store.get<Plugin>(plugin.id)).resolves.toMatchObject({ id: plugin.id });
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
