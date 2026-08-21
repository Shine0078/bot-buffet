import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { JsonStateStore } from './store.js';
import {
  Agent,
  ApprovalRequest,
  BaseEntity,
  Checkpoint,
  Credential,
  Environment,
  EvaluationCase,
  EvaluationDataset,
  MemoryItem,
  MCPServer,
  Model,
  ModelProvider,
  Plugin,
  Project,
  ProjectFile,
  Run,
  Source,
  Task,
  Workspace,
  entity,
  now,
} from './types.js';
import { Orchestrator } from './orchestrator.js';
import { adapterFor, defaultCapabilities } from './providers.js';
import { assertSafeEndpoint, assertWorkspacePath, redactSecrets, fingerprint } from './security.js';
import { CredentialVault } from './secrets.js';
import { AuthorizationService } from './authorization.js';

export interface ApiDeps {
  store: JsonStateStore;
  orchestrator: Orchestrator;
  uiRoot: string;
  vault: CredentialVault;
  registerProvider?: (provider: ModelProvider) => void;
}
const send = (res: ServerResponse, status: number, payload: unknown): void => {
  res.statusCode = status;
  if (status === 204) {
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(redactSecrets(payload)));
};
const MAX_BODY_BYTES = 2_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const requestBuckets = new Map<string, { startedAt: number; count: number }>();
const parseBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error('request_body_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += Buffer.byteLength(chunk);
    if (total > MAX_BODY_BYTES) throw new Error('request_body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('invalid_json');
  }
};

export function createApi(deps: ApiDeps) {
  const authorization = new AuthorizationService(deps.store);
  const visible = async <T extends BaseEntity>(
    actorId: string,
    values: T[],
    action: 'read' | 'write' | 'run' | 'approve' | 'admin' = 'read',
  ) => authorization.filter(actorId, values, action);
  const required = async <T extends BaseEntity>(
    actorId: string,
    value: T | undefined,
    action: 'read' | 'write' | 'run' | 'approve' | 'admin' = 'read',
    expectedKind?: string,
  ) => {
    if (
      expectedKind &&
      (value as (BaseEntity & { kind?: string }) | undefined)?.kind !== expectedKind
    )
      throw new Error('forbidden_or_not_found');
    return (await authorization.require(actorId, value, action)) as T;
  };
  const subscribers = new Set<{
    res: ServerResponse;
    projectId?: string;
    heartbeat: NodeJS.Timeout;
  }>();
  deps.orchestrator.on('run', (event) => {
    const safeEvent = redactSecrets(event) as Record<string, unknown>;
    const run = safeEvent.run as Record<string, unknown> | undefined;
    const approval = safeEvent.approval as Record<string, unknown> | undefined;
    const eventProjectId = String(run?.projectId ?? approval?.scope ?? safeEvent.projectId ?? '');
    const data = `data: ${JSON.stringify(safeEvent)}\n\n`;
    for (const subscriber of subscribers)
      if (!subscriber.projectId || !eventProjectId || subscriber.projectId === eventProjectId)
        try {
          subscriber.res.write(data);
        } catch {
          clearInterval(subscriber.heartbeat);
          subscribers.delete(subscriber);
        }
  });
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    );
    if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'access-control-allow-origin',
      process.env.BOT_BUFFET_ALLOWED_ORIGINS ?? 'http://localhost:8787',
    );
    res.setHeader('access-control-allow-headers', 'content-type,authorization,idempotency-key');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const actorId =
      process.env.BOT_BUFFET_AUTH_MODE === 'production'
        ? String(process.env.BOT_BUFFET_API_SUBJECT ?? 'production-user')
        : String(req.headers['x-bot-buffet-user'] ?? 'local-user');
    if (path.startsWith('/api/')) {
      const key = req.socket.remoteAddress ?? 'unknown';
      const current = requestBuckets.get(key);
      const nowMs = Date.now();
      if (!current || nowMs - current.startedAt >= RATE_WINDOW_MS)
        requestBuckets.set(key, { startedAt: nowMs, count: 1 });
      else if (current.count >= RATE_LIMIT) {
        res.setHeader('retry-after', '60');
        send(res, 429, { code: 'rate_limited', requestId });
        return;
      } else current.count += 1;
      if (requestBuckets.size > 10_000)
        for (const [bucketKey, bucket] of requestBuckets)
          if (nowMs - bucket.startedAt >= RATE_WINDOW_MS) requestBuckets.delete(bucketKey);
    }
    if (process.env.BOT_BUFFET_AUTH_MODE === 'production') {
      const expected = process.env.BOT_BUFFET_API_TOKEN;
      const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const expectedFingerprint = expected ? Buffer.from(fingerprint(expected)) : Buffer.alloc(0);
      const presentedFingerprint = Buffer.from(fingerprint(presented));
      if (
        !expected ||
        !presented ||
        expectedFingerprint.length !== presentedFingerprint.length ||
        !timingSafeEqual(expectedFingerprint, presentedFingerprint)
      ) {
        send(res, 401, { code: 'unauthorized' });
        return;
      }
    }
    try {
      const idempotencyHeader = String(req.headers['idempotency-key'] ?? '').trim();
      const idempotencyEligible = req.method === 'POST' && path === '/api/v1/runs';
      if (idempotencyEligible && idempotencyHeader) {
        if (idempotencyHeader.length > 256)
          return send(res, 400, { code: 'idempotency_key_too_long', requestId });
        const idempotencyScope = `${actorId}:${path}:${fingerprint(idempotencyHeader)}`;
        const replay = await deps.store.getIdempotency(idempotencyScope);
        if (replay)
          return send(
            res,
            replay.status === 102 ? 409 : replay.status,
            replay.status === 102 ? { code: 'idempotency_in_progress' } : replay.payload,
          );
        req.headers['x-bot-buffet-idempotency-scope'] = idempotencyScope;
      }
      if (path === '/healthz')
        return send(res, 200, { status: 'ok', service: 'bot-buffet', time: now() });
      if (path === '/readyz')
        return send(res, 200, {
          status: 'ready',
          storage: 'durable-json',
          auth: process.env.BOT_BUFFET_AUTH_MODE ?? 'development',
        });
      if (path === '/events' && req.method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        if (process.env.BOT_BUFFET_AUTH_MODE === 'production' && !projectId)
          return send(res, 400, { code: 'project_scope_required' });
        if (projectId)
          await required(actorId, await deps.store.get<Project>(projectId), 'read', 'project');
        if (subscribers.size >= 100) return send(res, 429, { code: 'sse_capacity_reached' });
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
        const heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(': heartbeat\n\n');
          } catch {
            clearInterval(heartbeat);
          }
        }, 30_000);
        const subscriber = { res, projectId, heartbeat };
        subscribers.add(subscriber);
        req.on('close', () => {
          clearInterval(heartbeat);
          subscribers.delete(subscriber);
        });
        return;
      }
      if (path === '/api/v1/bootstrap' && req.method === 'GET')
        return send(res, 200, {
          workspaces: await visible(
            actorId,
            await deps.store.list<Workspace>((x) => x.kind === 'workspace'),
          ),
          projects: await visible(
            actorId,
            await deps.store.list<Project>((x) => x.kind === 'project' && !(x as Project).archived),
          ),
          agents: await visible(actorId, await deps.store.list<Agent>((x) => x.kind === 'agent')),
          tasks: await visible(actorId, await deps.store.list<Task>((x) => x.kind === 'task')),
          runs: await visible(actorId, await deps.store.list((x) => x.kind === 'run'), 'run'),
          models: await visible(actorId, await deps.store.list<Model>((x) => x.kind === 'model')),
          providers: await visible(
            actorId,
            await deps.store.list<ModelProvider>((x) => x.kind === 'model-provider'),
          ),
          approvals: await visible(
            actorId,
            await deps.store.list<ApprovalRequest>(
              (x) => x.kind === 'approval-request' && (x as ApprovalRequest).status === 'pending',
            ),
          ),
          plugins: await visible(
            actorId,
            await deps.store.list<Plugin>((x) => x.kind === 'plugin'),
          ),
          audit: await visible(actorId, await deps.store.list((x) => x.kind === 'audit-event')),
        });
      if (path === '/api/v1/projects' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Project>((x) => x.kind === 'project')),
        );
      if (path === '/api/v1/projects' && req.method === 'POST') {
        const body = await parseBody(req);
        const workspaceId = String(body.workspaceId ?? 'workspace_local');
        const workspace = await deps.store.get<Workspace>(workspaceId);
        if (workspace) await required(actorId, workspace, 'write', 'workspace');
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('workspace_scope_required');
        const project = entity({
          kind: 'project',
          ownerId: actorId,
          scope: workspaceId,
          workspaceId,
          name: String(body.name ?? 'Untitled project'),
          slug: String(
            body.slug ??
              String(body.name ?? 'untitled-project')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-'),
          ),
          archived: false,
        });
        await deps.store.insert(project);
        return send(res, 201, project);
      }
      const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (projectMatch && req.method === 'PATCH') {
        const project = await required(
          actorId,
          await deps.store.get<Project>(projectMatch[1]!),
          'write',
          'project',
        );
        const body = await parseBody(req);
        const saved = await deps.store.put({
          ...project,
          name: body.name ? String(body.name) : project.name,
          archived: body.archived === undefined ? project.archived : Boolean(body.archived),
          updatedAt: now(),
          version: project.version,
        } as Project);
        return send(res, 200, saved);
      }
      if (path === '/api/v1/providers' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<ModelProvider>((x) => x.kind === 'model-provider'),
          ),
        );
      if (path === '/api/v1/providers' && req.method === 'POST') {
        const body = await parseBody(req);
        const scope = String(body.scope ?? 'workspace_local');
        const scopeEntity = await deps.store.get(scope);
        if (scopeEntity) await required(actorId, scopeEntity, 'write', 'workspace');
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('provider_scope_required');
        const providerKind = String(
          body.providerKind ?? 'openai-compatible',
        ) as ModelProvider['providerKind'];
        assertSafeEndpoint(
          String(body.endpoint ?? 'http://127.0.0.1:11434/v1'),
          ['ollama', 'lmstudio', 'llamacpp', 'localai', 'vllm', 'jan'].includes(providerKind),
        );
        let provider = entity({
          kind: 'model-provider',
          ownerId: actorId,
          scope,
          name: String(body.name ?? body.providerKind ?? 'Provider'),
          providerKind: String(providerKind) as ModelProvider['providerKind'],
          endpoint: String(body.endpoint ?? 'http://127.0.0.1:11434/v1'),
          credentialId: undefined,
          enabled: true,
          health: 'unknown',
          capabilities: defaultCapabilities(),
        }) as ModelProvider;
        await deps.store.insert(provider);
        deps.registerProvider?.(provider);
        if (body.token) {
          await deps.vault.set(provider.id, String(body.token));
          const credential = entity({
            kind: 'credential',
            ownerId: actorId,
            scope: provider.scope,
            metadata: {
              providerId: provider.id,
              label: `${provider.name} credential`,
              authType: 'api-key' as const,
              scopes: [],
              disabled: false,
              fingerprint: fingerprint(String(body.token)),
            },
            secretRef: provider.id,
          }) as Credential;
          await deps.store.insert(credential);
          provider = await deps.store.put({
            ...provider,
            credentialId: credential.id,
            version: provider.version,
          } as ModelProvider);
          deps.registerProvider?.(provider);
          await deps.store.audit({
            kind: 'audit-event',
            ownerId: actorId,
            scope: provider.scope,
            actorId,
            action: 'credential.connected',
            resourceType: 'model-provider',
            resourceId: provider.id,
            risk: 'critical',
            decision: 'executed',
            metadata: { fingerprint: fingerprint(String(body.token)), authType: 'api-key' },
          });
        }
        return send(res, 201, provider);
      }
      const providerTest = path.match(/^\/api\/v1\/providers\/([^/]+)\/test$/);
      if (providerTest && req.method === 'POST') {
        const provider = await required(
          actorId,
          await deps.store.get<ModelProvider>(providerTest[1]!),
          'write',
          'model-provider',
        );
        const health = await adapterFor(provider, deps.vault.getSync(provider.id)).health();
        const saved = await deps.store.put({
          ...provider,
          health,
          version: provider.version,
        } as ModelProvider);
        deps.registerProvider?.(saved);
        return send(res, 200, { provider: saved, health });
      }
      const providerDelete = path.match(/^\/api\/v1\/providers\/([^/]+)$/);
      if (providerDelete && req.method === 'DELETE') {
        const provider = await required(
          actorId,
          await deps.store.get<ModelProvider>(providerDelete[1]!),
          'admin',
          'model-provider',
        );
        await deps.vault.revoke(provider.id);
        const credential = await deps.store.get<Credential>(provider.credentialId ?? '');
        if (credential)
          await deps.store.put({
            ...credential,
            metadata: { ...credential.metadata, disabled: true },
            version: credential.version,
          } as Credential);
        const saved = await deps.store.put({
          ...provider,
          enabled: false,
          health: 'offline',
          version: provider.version,
        } as ModelProvider);
        deps.registerProvider?.(saved);
        return send(res, 200, saved);
      }
      if (path === '/api/v1/credentials' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Credential>((x) => x.kind === 'credential')),
        );
      if (path === '/api/v1/models' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Model>((x) => x.kind === 'model')),
        );
      if (path === '/api/v1/models' && req.method === 'POST') {
        const body = await parseBody(req);
        const provider = await required(
          actorId,
          await deps.store.get<ModelProvider>(String(body.providerId)),
          'write',
          'model-provider',
        );
        const model = entity({
          kind: 'model',
          ownerId: actorId,
          scope: provider.scope,
          providerId: provider.id,
          name: String(body.name ?? body.modelName),
          modelName: String(body.modelName),
          local: Boolean(body.local),
          capabilities: { ...defaultCapabilities(), ...((body.capabilities as object) ?? {}) },
          inputCostPerMillionCents: Number(body.inputCostPerMillionCents ?? 0),
          outputCostPerMillionCents: Number(body.outputCostPerMillionCents ?? 0),
          available: true,
        });
        await deps.store.insert(model);
        return send(res, 201, model);
      }
      if (path === '/api/v1/memory' && req.method === 'GET') {
        const namespace = url.searchParams.get('namespace');
        const namespaceId = url.searchParams.get('namespaceId');
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<MemoryItem>(
              (x) =>
                x.kind === 'memory' &&
                (!namespace || (x as MemoryItem).namespace === namespace) &&
                (!namespaceId || (x as MemoryItem).namespaceId === namespaceId),
            ),
          ),
        );
      }
      if (path === '/api/v1/memory' && req.method === 'POST') {
        const body = await parseBody(req);
        const namespaceId = String(body.namespaceId ?? body.scope ?? 'project_local');
        const namespace = String(body.namespace ?? 'project') as MemoryItem['namespace'];
        const namespaceKinds: Partial<Record<MemoryItem['namespace'], string>> = {
          user: 'user',
          organization: 'organization',
          workspace: 'workspace',
          project: 'project',
          environment: 'environment',
          agent: 'agent',
          task: 'task',
          artifact: 'artifact',
        };
        if (!(namespace in namespaceKinds) && namespace !== 'session')
          throw new Error('memory_namespace_invalid');
        const namespaceEntity = await deps.store.get(namespaceId);
        if (namespace === 'session' && namespaceEntity)
          throw new Error('memory_session_scope_invalid');
        if (namespaceEntity)
          await required(actorId, namespaceEntity, 'write', namespaceKinds[namespace]);
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('memory_scope_required');
        const memory = entity({
          kind: 'memory',
          ownerId: actorId,
          scope: namespaceId,
          namespace,
          namespaceId,
          text: String(body.text ?? ''),
          data: body.data as Record<string, unknown> | undefined,
          sourceIds: [],
          approved: false,
          freshnessAt: now(),
          expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
        }) as MemoryItem;
        await deps.store.insert(memory);
        return send(res, 201, memory);
      }
      const memoryMatch = path.match(/^\/api\/v1\/memory\/([^/]+)$/);
      if (memoryMatch && req.method === 'DELETE') {
        await required(
          actorId,
          await deps.store.get<MemoryItem>(memoryMatch[1]!),
          'write',
          'memory',
        );
        await deps.store.delete(memoryMatch[1]!);
        return send(res, 204, { deleted: true });
      }
      if (path === '/api/v1/plugins' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Plugin>((x) => x.kind === 'plugin')),
        );
      if (path === '/api/v1/plugins' && req.method === 'POST') {
        const body = await parseBody(req);
        const scope = String(body.scope ?? 'workspace_local');
        const scopeEntity = await deps.store.get(scope);
        if (scopeEntity) await required(actorId, scopeEntity, 'admin', 'workspace');
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('plugin_scope_required');
        const plugin = entity({
          kind: 'plugin',
          ownerId: actorId,
          scope,
          name: String(body.name ?? 'Plugin'),
          releaseVersion: String(body.version ?? '0.1.0'),
          source: String(body.source ?? 'user'),
          enabled: false,
          pinned: Boolean(body.pinned),
          dependencies: [],
          workspaceEnabled: false,
          projectIds: [],
          agentIds: [],
          network: 'blocked' as const,
          retention: String(body.retention ?? '30d'),
          permissions: [],
        }) as Plugin;
        await deps.store.insert(plugin);
        return send(res, 201, plugin);
      }
      const pluginMatch = path.match(/^\/api\/v1\/plugins\/([^/]+)\/(enable|disable)$/);
      if (pluginMatch && req.method === 'POST') {
        const plugin = await required(
          actorId,
          await deps.store.get<Plugin>(pluginMatch[1]!),
          'admin',
          'plugin',
        );
        const enabled = pluginMatch[2] === 'enable';
        const saved = await deps.store.put({
          ...plugin,
          enabled,
          workspaceEnabled: enabled,
          version: plugin.version,
        } as Plugin);
        return send(res, 200, saved);
      }
      const pluginUpdate = path.match(/^\/api\/v1\/plugins\/([^/]+)\/(update|rollback)$/);
      if (pluginUpdate && req.method === 'POST') {
        const plugin = await required(
          actorId,
          await deps.store.get<Plugin>(pluginUpdate[1]!),
          'admin',
          'plugin',
        );
        if (plugin.enabled || plugin.workspaceEnabled)
          throw new Error('plugin_update_requires_disabled');
        const body = await parseBody(req);
        const integrity = body.integritySha256
          ? String(body.integritySha256)
          : plugin.integritySha256;
        if (!integrity || !/^[a-f0-9]{64}$/i.test(integrity))
          throw new Error('plugin_integrity_required');
        const nextVersion =
          pluginUpdate[2] === 'rollback'
            ? plugin.previousReleaseVersion
            : String(body.version ?? plugin.releaseVersion);
        if (!nextVersion) throw new Error('plugin_rollback_unavailable');
        const saved = await deps.store.put({
          ...plugin,
          previousReleaseVersion: plugin.releaseVersion,
          releaseVersion: nextVersion,
          source: body.source ? String(body.source) : plugin.source,
          integritySha256: integrity,
          version: plugin.version,
        } as Plugin);
        return send(res, 200, saved);
      }
      const pluginDelete = path.match(/^\/api\/v1\/plugins\/([^/]+)$/);
      if (pluginDelete && req.method === 'DELETE') {
        await required(actorId, await deps.store.get<Plugin>(pluginDelete[1]!), 'admin', 'plugin');
        await deps.store.delete(pluginDelete[1]!);
        return send(res, 204, { deleted: true });
      }
      if (path === '/api/v1/mcp-servers' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<MCPServer>((x) => x.kind === 'mcp-server')),
        );
      if (path === '/api/v1/mcp-servers' && req.method === 'POST') {
        const body = await parseBody(req);
        const scope = String(body.scope ?? 'workspace_local');
        const scopeEntity = await deps.store.get(scope);
        if (scopeEntity) await required(actorId, scopeEntity, 'admin', 'workspace');
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('mcp_scope_required');
        const transport = String(body.transport ?? 'streamable-http') as MCPServer['transport'];
        const endpoint = String(body.endpoint ?? '');
        if (!['stdio', 'sse', 'streamable-http'].includes(transport))
          throw new Error('mcp_transport_invalid');
        if (transport !== 'stdio') assertSafeEndpoint(endpoint);
        const serverEntity = entity({
          kind: 'mcp-server',
          ownerId: actorId,
          scope,
          name: String(body.name ?? 'MCP server'),
          endpoint,
          transport,
          enabled: false,
          toolNames: [],
          integritySha256: body.integritySha256 ? String(body.integritySha256) : undefined,
        }) as MCPServer;
        await deps.store.insert(serverEntity);
        return send(res, 201, serverEntity);
      }
      const mcpMatch = path.match(/^\/api\/v1\/mcp-servers\/([^/]+)\/(enable|disable)$/);
      if (mcpMatch && req.method === 'POST') {
        const serverEntity = await required(
          actorId,
          await deps.store.get<MCPServer>(mcpMatch[1]!),
          'admin',
          'mcp-server',
        );
        const saved = await deps.store.put({
          ...serverEntity,
          enabled: mcpMatch[2] === 'enable',
          version: serverEntity.version,
        } as MCPServer);
        return send(res, 200, saved);
      }
      if (path === '/api/v1/files' && req.method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<ProjectFile>(
              (x) =>
                x.kind === 'file' && (!projectId || (x as ProjectFile).projectId === projectId),
            ),
          ),
        );
      }
      if (path === '/api/v1/sources' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Source>((x) => x.kind === 'source')),
        );
      if (path === '/api/v1/sources' && req.method === 'POST') {
        const body = await parseBody(req);
        const projectId = String(body.projectId ?? 'project_local');
        const sourceProject = await deps.store.get<Project>(projectId);
        if (sourceProject) await required(actorId, sourceProject, 'write', 'project');
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('source_project_required');
        const uri = String(body.uri ?? '');
        assertSafeEndpoint(uri);
        const source = entity({
          kind: 'source',
          ownerId: actorId,
          scope: projectId,
          projectId,
          uri,
          title: body.title ? String(body.title) : undefined,
          status: 'pending' as const,
          quality: 'unknown' as const,
        }) as Source;
        await deps.store.insert(source);
        return send(res, 201, source);
      }
      if (path === '/api/v1/evaluations/datasets' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<EvaluationDataset>((x) => x.kind === 'evaluation-dataset'),
          ),
        );
      if (path === '/api/v1/evaluations/datasets' && req.method === 'POST') {
        const body = await parseBody(req);
        const scope = String(body.scope ?? 'workspace_local');
        const scopeEntity = await deps.store.get(scope);
        if (scopeEntity) await required(actorId, scopeEntity, 'write', 'workspace');
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('dataset_scope_required');
        const dataset = entity({
          kind: 'evaluation-dataset',
          ownerId: actorId,
          scope,
          name: String(body.name ?? 'Untitled dataset'),
          description: String(body.description ?? ''),
          caseIds: [],
          versionLabel: '1.0.0',
        }) as EvaluationDataset;
        await deps.store.insert(dataset);
        return send(res, 201, dataset);
      }
      if (path === '/api/v1/evaluations/cases' && req.method === 'POST') {
        const body = await parseBody(req);
        const datasetId = String(body.datasetId ?? 'dataset_local');
        const parentDataset = await required(
          actorId,
          await deps.store.get<EvaluationDataset>(datasetId),
          'write',
          'evaluation-dataset',
        ).catch(() => undefined);
        if (!parentDataset && process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('dataset_required');
        const evaluationCase = entity({
          kind: 'evaluation-case',
          ownerId: actorId,
          scope: datasetId,
          datasetId,
          name: String(body.name ?? 'Case'),
          input: body.input,
          expected: body.expected,
          graders: Array.isArray(body.graders) ? body.graders.map(String) : [],
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
        }) as EvaluationCase;
        await deps.store.insert(evaluationCase);
        const dataset = await deps.store.get<EvaluationDataset>(evaluationCase.datasetId);
        if (dataset)
          await deps.store.put({
            ...dataset,
            caseIds: [...dataset.caseIds, evaluationCase.id],
            version: dataset.version,
          } as EvaluationDataset);
        return send(res, 201, evaluationCase);
      }
      if (path === '/api/v1/observability/summary' && req.method === 'GET') {
        const runs = await visible(
          actorId,
          await deps.store.list<Run>((x) => x.kind === 'run'),
          'read',
        );
        return send(res, 200, {
          runs: runs.length,
          active: runs.filter((run) =>
            ['queued', 'running', 'waiting_approval', 'paused', 'retrying'].includes(run.status),
          ).length,
          completed: runs.filter((run) => run.status === 'completed').length,
          failed: runs.filter((run) => ['failed', 'blocked', 'cancelled'].includes(run.status))
            .length,
          tokensIn: runs.reduce((sum, run) => sum + run.tokensIn, 0),
          tokensOut: runs.reduce((sum, run) => sum + run.tokensOut, 0),
          costCents: runs.reduce((sum, run) => sum + run.costCents, 0),
          latencyMs: runs.reduce((sum, run) => sum + run.latencyMs, 0),
          auditValid: (await deps.store.verifyAuditChain()).valid,
        });
      }
      const replayMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/replay$/);
      if (replayMatch && req.method === 'GET') {
        await required(actorId, await deps.store.get<Run>(replayMatch[1]!), 'read', 'run');
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<Checkpoint>(
              (x) => x.kind === 'checkpoint' && (x as Checkpoint).runId === replayMatch[1]!,
            ),
          ),
        );
      }
      const exportMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/export$/);
      if (exportMatch && req.method === 'GET') {
        await required(actorId, await deps.store.get<Project>(exportMatch[1]!), 'read', 'project');
        const snapshot = await deps.store.snapshot();
        const scoped = Object.values(snapshot.entities).filter(
          (item) => item.scope === exportMatch[1] || item.id === exportMatch[1],
        );
        return send(res, 200, {
          schemaVersion: snapshot.schemaVersion,
          projectId: exportMatch[1],
          exportedAt: now(),
          entities: scoped,
        });
      }
      if (path === '/api/v1/runs' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await deps.store.get<Project>(String(body.projectId));
        const agent = await deps.store.get<Agent>(String(body.agentId));
        const task = await deps.store.get<Task>(String(body.taskId));
        if (!project || !agent || !task) return send(res, 400, { code: 'run_context_missing' });
        await required(actorId, project, 'run', 'project');
        await required(actorId, agent, 'run', 'agent');
        await required(actorId, task, 'run', 'task');
        if (agent.projectId !== project.id || task.projectId !== project.id)
          throw new Error('run_context_scope_mismatch');
        const environment = await deps.store.get<Environment>(agent.environmentId);
        if (
          !environment ||
          environment.projectId !== project.id ||
          task.environmentId !== environment.id
        )
          throw new Error('run_environment_scope_mismatch');
        const idempotencyScope = req.headers['x-bot-buffet-idempotency-scope'];
        if (idempotencyScope) {
          const claim = await deps.store.claimIdempotency(String(idempotencyScope));
          if (!claim.claimed)
            return send(
              res,
              claim.record.status === 102 ? 409 : claim.record.status,
              claim.record.status === 102
                ? { code: 'idempotency_in_progress' }
                : claim.record.payload,
            );
        }
        const run = await deps.orchestrator.createRun({
          ownerId: actorId,
          project,
          agent,
          task,
          mode: body.mode as never,
        });
        if (idempotencyScope) await deps.store.setIdempotency(String(idempotencyScope), 202, run);
        void deps.orchestrator.start(run.id);
        return send(res, 202, run);
      }
      if (path === '/api/v1/runs' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list((x) => x.kind === 'run'), 'read'),
        );
      const runMatch = path.match(
        /^\/api\/v1\/runs\/([^/]+)\/(pause|resume|cancel|stop|fork|rollback)$/,
      );
      if (runMatch && req.method === 'POST') {
        const body = await parseBody(req);
        const commandRun = await required(
          actorId,
          await deps.store.get<Run>(runMatch[1]!),
          'run',
          'run',
        );
        if (commandRun.projectId !== commandRun.scope) throw new Error('run_scope_mismatch');
        const result = await deps.orchestrator.command({
          runId: runMatch[1]!,
          type: runMatch[2] as never,
          checkpointId: body.checkpointId ? String(body.checkpointId) : undefined,
        });
        return send(res, 200, result ?? { code: 'not_found' });
      }
      if (path === '/api/v1/approvals' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<ApprovalRequest>(
              (x) => x.kind === 'approval-request' && (x as ApprovalRequest).status === 'pending',
            ),
            'approve',
          ),
        );
      const approvalMatch = path.match(/^\/api\/v1\/approvals\/([^/]+)$/);
      if (approvalMatch && req.method === 'POST') {
        const approval = await required(
          actorId,
          await deps.store.get<ApprovalRequest>(approvalMatch[1]!),
          'approve',
          'approval-request',
        );
        if (approval.status !== 'pending' || Date.parse(approval.expiresAt) <= Date.now())
          throw new Error('approval_not_pending_or_expired');
        const body = await parseBody(req);
        const status = body.approved ? ('approved' as const) : ('rejected' as const);
        const run = await required(
          actorId,
          await deps.store.get<Run>(approval.runId),
          'run',
          'run',
        );
        if (run.projectId !== approval.scope) throw new Error('approval_scope_mismatch');
        const saved = await deps.store.putIfVersion(
          {
            ...approval,
            status,
            decidedBy: actorId,
            decidedAt: now(),
            reason: body.reason ? String(body.reason) : undefined,
            version: approval.version,
          } as ApprovalRequest,
          approval.version,
        );
        if (status === 'approved')
          await deps.orchestrator.command({ runId: approval.runId, type: 'resume' });
        else {
          await deps.store.putIfVersion(
            {
              ...run,
              status: 'blocked',
              error: 'approval_rejected',
              finishedAt: now(),
              version: run.version,
            } as Run,
            run.version,
          );
        }
        return send(res, 200, saved);
      }
      if (path === '/api/v1/audit' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list((x) => x.kind === 'audit-event')),
        );
      if (path === '/api/v1/audit/verify' && req.method === 'GET')
        return send(res, 200, await deps.store.verifyAuditChain());
      if (path === '/api/v1/stop-all' && req.method === 'POST') {
        const runs = await visible(
          actorId,
          await deps.store.list<Run>(
            (x) =>
              x.kind === 'run' &&
              ['queued', 'running', 'waiting_approval', 'paused', 'retrying'].includes(
                (x as { status: string }).status,
              ),
          ),
          'run',
        );
        for (const run of runs) await deps.orchestrator.command({ runId: run.id, type: 'stop' });
        return send(res, 200, { stopped: runs.length });
      }
      if (path === '/' || !path.startsWith('/api/')) {
        const file = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
        const full = assertWorkspacePath(deps.uiRoot, file);
        try {
          const content = await readFile(full);
          res.statusCode = 200;
          res.setHeader(
            'content-type',
            extname(full) === '.html'
              ? 'text/html'
              : extname(full) === '.js'
                ? 'text/javascript'
                : 'text/css',
          );
          res.end(content);
        } catch {
          send(res, 404, { code: 'not_found' });
        }
        return;
      }
      send(res, 404, { code: 'not_found' });
    } catch (error) {
      const failure = {
        code: 'request_failed',
        message: redactSecrets((error as Error).message) as string,
      };
      const idempotencyScope = req.headers['x-bot-buffet-idempotency-scope'];
      if (idempotencyScope) await deps.store.setIdempotency(String(idempotencyScope), 400, failure);
      send(res, 400, failure);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.timeout = 35_000;
  return server;
}
