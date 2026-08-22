import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fetchPinned = vi.hoisted(() => vi.fn());
vi.mock('../src/egress.js', () => ({ fetchPinned }));

import { createApi } from '../src/api.js';
import { DeviceSessionStore } from '../src/oauth.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Credential, ModelProvider, entity } from '../src/types.js';

const servers: Array<ReturnType<typeof createApi>> = [];

afterEach(async () => {
  fetchPinned.mockReset();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('device authorization API', () => {
  it('keeps device_code server-side, handles pending, then stores the token encrypted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-device-'));
    const store = createStore(dir);
    const provider = entity({
      kind: 'model-provider',
      ownerId: 'local-user',
      scope: 'workspace_local',
      name: 'Device Provider',
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
        deviceAuthorizationEndpoint: 'https://login.example.test/device',
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
      device: new DeviceSessionStore(),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server_address_missing');
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          device_code: 'server-only-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://login.example.test/device',
          expires_in: 600,
          interval: 1,
        }),
        { status: 200 },
      ),
    );
    const startResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/device/start`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(startResponse.status).toBe(200);
    const startPayload = (await startResponse.json()) as {
      sessionId: string;
      userCode: string;
      verificationUri: string;
      intervalSeconds: number;
    };
    expect(startPayload.userCode).toBe('ABCD-EFGH');
    expect(startPayload).not.toHaveProperty('deviceCode');
    expect(JSON.stringify(startPayload)).not.toContain('server-only-device-code');

    fetchPinned.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
    );
    const pending = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/device/poll`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: startPayload.sessionId }),
      },
    );
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ status: 'pending', retryAfterSeconds: 1 });

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    fetchPinned.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'device-access-token' }), { status: 200 }),
    );
    const connected = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/device/poll`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: startPayload.sessionId }),
      },
    );
    expect(connected.status).toBe(200);
    const connectedPayload = (await connected.json()) as {
      credential: { metadata: { authType: string } };
    };
    expect(connectedPayload.credential.metadata.authType).toBe('device');
    const savedProvider = await store.get<ModelProvider>(provider.id);
    const credential = await store.get<Credential>(savedProvider?.credentialId ?? '');
    expect(credential?.metadata.authType).toBe('device');
    expect(JSON.stringify(credential)).not.toContain('device-access-token');
  });

  it('returns a bounded slowdown response without exposing the provider error body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-device-'));
    const store = createStore(dir);
    const provider = entity({
      kind: 'model-provider',
      ownerId: 'local-user',
      scope: 'workspace_local',
      name: 'Device Provider',
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
        deviceAuthorizationEndpoint: 'https://login.example.test/device',
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
      device: new DeviceSessionStore(),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server_address_missing');
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          device_code: 'server-only-device-code',
          user_code: 'ABCD',
          verification_uri: 'https://login.example.test/device',
          interval: 1,
        }),
        { status: 200 },
      ),
    );
    const startResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/device/start`,
      { method: 'POST', body: '{}' },
    );
    const startPayload = (await startResponse.json()) as { sessionId: string };
    fetchPinned.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'slow_down', detail: 'provider-secret-error' }), {
        status: 400,
      }),
    );
    const poll = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/device/poll`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: startPayload.sessionId }),
      },
    );
    expect(poll.status).toBe(202);
    const payload = await poll.json();
    expect(payload).toMatchObject({ status: 'pending', retryAfterSeconds: 6 });
    expect(JSON.stringify(payload)).not.toContain('provider-secret-error');
  });

  it('rolls back an exchanged device credential when the provider CAS loses a race', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-device-'));
    const store = createStore(dir);
    const provider = entity({
      kind: 'model-provider',
      ownerId: 'local-user',
      scope: 'workspace_local',
      name: 'Racing Device Provider',
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
        deviceAuthorizationEndpoint: 'https://login.example.test/device',
        clientId: 'client-1',
        scopes: ['models:read'],
        redirectUri: 'http://127.0.0.1:8787/oauth/callback',
      },
    }) as ModelProvider;
    await store.insert(provider);
    const vault = new CredentialVault(join(dir, 'credentials.enc.json'), 'test');
    const server = createApi({
      store,
      orchestrator: new EventEmitter() as unknown as Orchestrator,
      uiRoot: dir,
      vault,
      device: new DeviceSessionStore(),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server_address_missing');

    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          device_code: 'race-device-code',
          user_code: 'RACE',
          verification_uri: 'https://login.example.test/device',
          expires_in: 600,
          interval: 1,
        }),
        { status: 200 },
      ),
    );
    const startResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/device/start`,
      { method: 'POST', body: '{}' },
    );
    const startPayload = (await startResponse.json()) as { sessionId: string };
    fetchPinned.mockImplementationOnce(async () => {
      await store.put({
        ...provider,
        name: 'Concurrent provider update',
        version: provider.version,
      });
      return new Response(JSON.stringify({ access_token: 'race-access-token' }), { status: 200 });
    });
    const poll = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/providers/${provider.id}/device/poll`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: startPayload.sessionId }),
      },
    );
    expect(poll.status).toBe(400);
    expect((await store.get<ModelProvider>(provider.id))?.name).toBe('Concurrent provider update');
    expect(await store.list<Credential>((item) => item.kind === 'credential')).toHaveLength(0);
    expect(vault.getSync(provider.id)).toBeUndefined();
  });
});
