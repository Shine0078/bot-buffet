import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { JsonStateStore } from './store.js';
import {
  Agent,
  Alert,
  ApprovalRequest,
  Artifact,
  BaseEntity,
  Budget,
  BudgetPeriod,
  Checkpoint,
  CostRecord,
  Credential,
  Entity,
  Environment,
  EvaluationCase,
  EvaluationDataset,
  EvaluationRun,
  MemoryItem,
  MCPServer,
  Model,
  ModelRoute,
  ModelProvider,
  Plugin,
  Project,
  ProjectFile,
  Risk,
  Run,
  RunStep,
  Schedule,
  Source,
  Task,
  UsageRecord,
  Webhook,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  Workspace,
  OAuthProviderConfig,
  entity,
  now,
} from './types.js';
import { Orchestrator } from './orchestrator.js';
import {
  adapterFor,
  defaultCapabilities,
  discoverLocalEndpoints,
  localDiscoveryCandidates,
  LocalDiscoveryResult,
  resolveProviderToken,
} from './providers.js';
import { assertSafeEndpoint, assertWorkspacePath, redactSecrets, fingerprint } from './security.js';
import { CredentialVault } from './secrets.js';
import { AuthorizationService } from './authorization.js';
import { AuthenticationError, authenticateRequest } from './auth.js';
import { ToolRegistry } from './tools.js';
import {
  DeviceSessionStore,
  PkceSessionStore,
  validateDeviceAuthorizationEndpoint,
} from './oauth.js';
import { fetchPinned } from './egress.js';
import { compareToBaseline, evaluateCases, releaseGate } from './evaluations.js';
import { budgetStatus, estimateCostCents, evaluateBudgets } from './budgets.js';
import { CostGrouping, costReport, forecastCents } from './reporting.js';
import { readyNodes, validateWorkflow, workflowLevels } from './workflow.js';
import { checkpointManifest, scanArtifact, sha256 } from './artifacts.js';
import { renderMetrics, runToOtlp } from './telemetry.js';

export interface ApiDeps {
  store: JsonStateStore;
  orchestrator: Orchestrator;
  uiRoot: string;
  vault: CredentialVault;
  tools?: ToolRegistry;
  oauth?: PkceSessionStore;
  device?: DeviceSessionStore;
  registerProvider?: (provider: ModelProvider) => void;
  discoverLocal?: () => Promise<LocalDiscoveryResult[]>;
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

const parseOAuthConfig = (value: unknown): OAuthProviderConfig | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const scopes = Array.isArray(candidate.scopes)
    ? candidate.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  if (
    typeof candidate.authorizationEndpoint !== 'string' ||
    typeof candidate.tokenEndpoint !== 'string' ||
    typeof candidate.clientId !== 'string' ||
    typeof candidate.redirectUri !== 'string' ||
    scopes.length === 0
  )
    throw new Error('oauth_configuration_invalid');
  if (
    candidate.deviceAuthorizationEndpoint !== undefined &&
    typeof candidate.deviceAuthorizationEndpoint !== 'string'
  )
    throw new Error('oauth_configuration_invalid');
  return {
    authorizationEndpoint: candidate.authorizationEndpoint,
    tokenEndpoint: candidate.tokenEndpoint,
    ...(typeof candidate.deviceAuthorizationEndpoint === 'string'
      ? { deviceAuthorizationEndpoint: candidate.deviceAuthorizationEndpoint }
      : {}),
    clientId: candidate.clientId,
    redirectUri: candidate.redirectUri,
    scopes,
  };
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
    try {
      const oauthCallback = path.match(/^\/api\/v1\/providers\/([^/]+)\/oauth\/callback$/);
      if (oauthCallback && req.method === 'GET') {
        if (!deps.oauth) throw new Error('oauth_not_configured');
        const provider = await deps.store.get<ModelProvider>(oauthCallback[1]!);
        if (!provider?.oauth) throw new Error('oauth_not_configured');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const failure = url.searchParams.get('error');
        if (!state || state.length > 256) throw new Error('oauth_callback_invalid');
        const session = deps.oauth.consume(provider.id, state);
        if (failure) throw new Error(`oauth_provider_denied:${failure.slice(0, 64)}`);
        if (!code || code.length > 4096) throw new Error('oauth_callback_invalid');
        const tokenEndpoint = new URL(provider.oauth.tokenEndpoint);
        const tokenResponse = await fetchPinned(
          tokenEndpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              client_id: provider.oauth.clientId,
              redirect_uri: session.redirectUri,
              code_verifier: session.verifier,
            }).toString(),
            signal: AbortSignal.timeout(15_000),
          },
          false,
        );
        if (!tokenResponse.ok)
          throw new Error(`oauth_token_exchange_failed:${tokenResponse.status}`);
        const tokenPayload = (await tokenResponse.json()) as { access_token?: unknown };
        if (typeof tokenPayload.access_token !== 'string' || tokenPayload.access_token.length < 8)
          throw new Error('oauth_access_token_missing');
        await deps.vault.set(provider.id, tokenPayload.access_token);
        const existing = provider.credentialId
          ? await deps.store.get<Credential>(provider.credentialId)
          : undefined;
        const credential = existing
          ? await deps.store.put({
              ...existing,
              metadata: {
                ...existing.metadata,
                authType: 'oauth-pkce',
                scopes: provider.oauth.scopes,
                disabled: false,
                lastTestedAt: now(),
                fingerprint: fingerprint(tokenPayload.access_token),
              },
              version: existing.version,
            } as Credential)
          : ((await deps.store.insert(
              entity({
                kind: 'credential',
                ownerId: session.actorId,
                scope: provider.scope,
                metadata: {
                  providerId: provider.id,
                  label: `${provider.name} OAuth credential`,
                  authType: 'oauth-pkce' as const,
                  scopes: provider.oauth.scopes,
                  disabled: false,
                  lastTestedAt: now(),
                  fingerprint: fingerprint(tokenPayload.access_token),
                },
                secretRef: provider.id,
              }) as Credential,
            )) as Credential);
        const saved = await deps.store.put({
          ...provider,
          credentialId: credential.id,
          version: provider.version,
        } as ModelProvider);
        deps.registerProvider?.(saved);
        await deps.store.audit({
          kind: 'audit-event',
          ownerId: session.actorId,
          scope: provider.scope,
          actorId: session.actorId,
          action: 'credential.connected',
          resourceType: 'model-provider',
          resourceId: provider.id,
          risk: 'critical',
          decision: 'executed',
          metadata: { authType: 'oauth-pkce', scopes: provider.oauth.scopes },
        });
        return send(res, 200, {
          provider: saved,
          credential: { id: credential.id, metadata: credential.metadata },
        });
      }
      let actorId: string;
      try {
        actorId = await authenticateRequest(req, process.env.BOT_BUFFET_AUTH_MODE ?? 'development');
      } catch (error) {
        if (error instanceof AuthenticationError) {
          send(res, error.status, { code: error.code, requestId });
          return;
        }
        throw error;
      }
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
      if (path === '/metrics' && req.method === 'GET') {
        const runs = await visible(
          actorId,
          await deps.store.list<Run>((x) => x.kind === 'run'),
          'read',
        );
        const active = runs.filter((run) =>
          ['queued', 'running', 'waiting_approval', 'paused', 'retrying'].includes(run.status),
        ).length;
        const alerts = await visible(
          actorId,
          await deps.store.list<Alert>((x) => x.kind === 'alert'),
        );
        const body = renderMetrics([
          { name: 'bot_buffet_runs_total', value: runs.length, unit: 'runs' },
          { name: 'bot_buffet_runs_active', value: active, unit: 'runs' },
          {
            name: 'bot_buffet_runs_failed',
            value: runs.filter((run) => ['failed', 'blocked', 'cancelled'].includes(run.status))
              .length,
            unit: 'runs',
          },
          {
            name: 'bot_buffet_cost_cents_total',
            value: runs.reduce((sum, run) => sum + (run.costCents || 0), 0),
            unit: 'cents',
          },
          {
            name: 'bot_buffet_alerts_unacknowledged',
            value: alerts.filter((alert) => !alert.acknowledged).length,
            unit: 'alerts',
          },
        ]);
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(body + '\n');
        return;
      }
      if (path === '/api/v1/local-models/discover' && req.method === 'GET')
        return send(res, 200, {
          providers: await (deps.discoverLocal ?? discoverLocalEndpoints)(),
          offlineOnly: true,
        });
      if (path === '/api/v1/local-models/register' && req.method === 'POST') {
        const body = await parseBody(req);
        const providerKind = String(body.providerKind ?? 'ollama') as ModelProvider['providerKind'];
        if (!localDiscoveryCandidates().some(([kind]) => kind === providerKind))
          throw new Error('local_provider_kind_invalid');
        const endpoint = String(body.endpoint ?? '');
        assertSafeEndpoint(endpoint, true);
        const scope = String(body.scope ?? 'workspace_local');
        const scopeEntity = await deps.store.get(scope);
        if (scopeEntity) await required(actorId, scopeEntity, 'write', 'workspace');
        else if (process.env.BOT_BUFFET_AUTH_MODE === 'production')
          throw new Error('local_model_scope_required');
        const modelName = String(body.modelName ?? '')
          .trim()
          .slice(0, 200);
        if (!modelName) throw new Error('local_model_name_required');
        let provider = (
          await deps.store.list<ModelProvider>(
            (x) =>
              x.kind === 'model-provider' &&
              x.scope === scope &&
              x.providerKind === providerKind &&
              x.endpoint === endpoint,
          )
        )[0];
        if (!provider) {
          provider = entity({
            kind: 'model-provider',
            ownerId: actorId,
            scope,
            name: String(body.name ?? `${providerKind} local`).slice(0, 200),
            providerKind,
            endpoint,
            enabled: true,
            health: 'unknown',
            capabilities: defaultCapabilities(),
          }) as ModelProvider;
          await deps.store.insert(provider);
          deps.registerProvider?.(provider);
        } else await required(actorId, provider, 'write', 'model-provider');
        const existing = (
          await deps.store.list<Model>(
            (x) => x.kind === 'model' && x.providerId === provider!.id && x.modelName === modelName,
          )
        )[0];
        if (existing) await required(actorId, existing, 'read', 'model');
        const model =
          existing ??
          ((await deps.store.insert(
            entity({
              kind: 'model',
              ownerId: actorId,
              scope,
              providerId: provider.id,
              name: modelName,
              modelName,
              local: true,
              capabilities: provider.capabilities,
              inputCostPerMillionCents: 0,
              outputCostPerMillionCents: 0,
              available: true,
            }) as Model,
          )) as Model);
        return send(res, existing ? 200 : 201, { provider, model, offlineOnly: true });
      }
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
      if (path === '/api/v1/bootstrap' && req.method === 'GET') {
        const spendSources = {
          usage: await deps.store.list<UsageRecord>((x) => x.kind === 'usage'),
          costs: await deps.store.list<CostRecord>((x) => x.kind === 'cost'),
        };
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
          files: await visible(
            actorId,
            await deps.store.list<ProjectFile>((x) => x.kind === 'file'),
          ),
          memory: await visible(
            actorId,
            await deps.store.list<MemoryItem>((x) => x.kind === 'memory'),
          ),
          evaluations: await visible(
            actorId,
            await deps.store.list<EvaluationDataset>((x) => x.kind === 'evaluation-dataset'),
          ),
          budgets: (
            await visible(actorId, await deps.store.list<Budget>((x) => x.kind === 'budget'))
          ).map((budget) => ({ ...budget, status: budgetStatus(budget, spendSources) })),
          alerts: await visible(actorId, await deps.store.list<Alert>((x) => x.kind === 'alert')),
          workflows: await visible(
            actorId,
            await deps.store.list<Workflow>((x) => x.kind === 'workflow'),
          ),
          tools: deps.tools?.list() ?? [],
        });
      }
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
      if (projectMatch && req.method === 'DELETE') {
        const project = await required(
          actorId,
          await deps.store.get<Project>(projectMatch[1]!),
          'admin',
          'project',
        );
        const activeRuns = await deps.store.list<Run>(
          (x) =>
            x.kind === 'run' &&
            (x as Run).projectId === project.id &&
            ['queued', 'running', 'waiting_approval', 'paused', 'retrying'].includes(
              (x as Run).status,
            ),
        );
        if (activeRuns.length) throw new Error('project_delete_active_runs');
        const children = await deps.store.list<Entity>(
          (x) =>
            x.id === project.id ||
            x.scope === project.id ||
            (x as BaseEntity & { projectId?: string }).projectId === project.id,
        );
        for (const child of children)
          if (child.kind !== 'audit-event') {
            if (child.kind === 'credential') await deps.vault.revoke(child.id);
            if (child.kind === 'webhook') await deps.vault.revoke(`webhook:${child.id}`);
            await deps.store.delete(child.id);
          }
        await deps.store.audit({
          kind: 'audit-event',
          ownerId: actorId,
          scope: project.workspaceId,
          actorId,
          action: 'project.deleted',
          resourceType: 'project',
          resourceId: project.id,
          risk: 'critical',
          decision: 'executed',
          metadata: { deletedEntityCount: children.length },
        });
        return send(res, 204, { deleted: true });
      }
      if (path === '/api/v1/environments' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<Environment>((x) => x.kind === 'environment'),
          ),
        );
      if (path === '/api/v1/environments' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'write',
          'project',
        );
        const network = ['blocked', 'allowlist', 'open'].includes(String(body.network))
          ? (String(body.network) as Environment['network'])
          : 'blocked';
        const environment = entity({
          kind: 'environment',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          name: String(body.name ?? 'Environment').slice(0, 200),
          network,
          persistent: Boolean(body.persistent),
          protected: Boolean(body.protected),
        }) as Environment;
        await deps.store.insert(environment);
        return send(res, 201, environment);
      }
      if (path === '/api/v1/agents' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Agent>((x) => x.kind === 'agent')),
        );
      if (path === '/api/v1/agents' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'write',
          'project',
        );
        const environments = await deps.store.list<Environment>(
          (x) => x.kind === 'environment' && (x as Environment).projectId === project.id,
        );
        const environmentId = String(
          body.environmentId ?? project.defaultEnvironmentId ?? environments[0]?.id ?? '',
        );
        const environment = await required(
          actorId,
          await deps.store.get<Environment>(environmentId),
          'write',
          'environment',
        );
        if (environment.projectId !== project.id) throw new Error('agent_scope_mismatch');
        const raw =
          body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
            ? (body.profile as Record<string, unknown>)
            : {};
        const strings = (value: unknown, fallback: string[] = [], max = 64) =>
          (Array.isArray(value) ? value : fallback)
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.slice(0, 1000))
            .slice(0, max);
        const bounded = (value: unknown, fallback: number, min: number, max: number) => {
          const number = Number(value ?? fallback);
          return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
        };
        const requiredRisks = strings(
          raw.approvalPolicy && (raw.approvalPolicy as Record<string, unknown>).requiredRisks,
          ['high', 'critical'],
        ).filter((risk): risk is Risk =>
          ['safe', 'low', 'medium', 'high', 'critical'].includes(risk),
        );
        const profile = {
          name: String(raw.name ?? body.name ?? 'Agent').slice(0, 200),
          description: String(raw.description ?? '').slice(0, 2000),
          avatar: String(raw.avatar ?? '').slice(0, 32),
          mission: String(raw.mission ?? 'Complete tasks with evidence.').slice(0, 4000),
          systemInstructions: String(
            raw.systemInstructions ?? 'Be careful, explain actions, and never expose secrets.',
          ).slice(0, 12000),
          projectRules: strings(raw.projectRules, ['Stay inside the project workspace.']),
          skills: strings(raw.skills),
          allowedModels: strings(raw.allowedModels),
          preferredModelId: raw.preferredModelId ? String(raw.preferredModelId) : undefined,
          fallbackModelIds: strings(raw.fallbackModelIds),
          allowedToolIds: strings(raw.allowedToolIds),
          allowedPluginIds: strings(raw.allowedPluginIds),
          allowedPaths: strings(raw.allowedPaths, ['.']),
          protectedPaths: strings(raw.protectedPaths, ['.env', '.git']),
          network: ['blocked', 'allowlist', 'open'].includes(String(raw.network))
            ? (String(raw.network) as 'blocked' | 'allowlist' | 'open')
            : 'blocked',
          environmentKeys: strings(raw.environmentKeys),
          maxSteps: bounded(raw.maxSteps, 20, 1, 1000),
          timeLimitMs: bounded(raw.timeLimitMs, 900_000, 1000, 86_400_000),
          tokenLimit: bounded(raw.tokenLimit, 32_000, 128, 1_000_000),
          costLimitCents: bounded(raw.costLimitCents, 0, 0, 1_000_000_000),
          concurrencyLimit: bounded(raw.concurrencyLimit, 1, 1, 32),
          approvalPolicy: {
            requiredRisks,
            autoApproveReversible: false,
            expiryMs: 900_000,
            delegates: [],
          },
          verificationPolicy: {
            deterministic: [],
            inferential: [],
            requireEvidence: true,
          },
          memoryPolicy: {
            readableScopes: ['project'],
            writableScopes: ['project'],
            requireApproval: true,
            retentionDays: 30,
          },
          outputFormat: ['text', 'json', 'markdown'].includes(String(raw.outputFormat))
            ? (String(raw.outputFormat) as 'text' | 'json' | 'markdown')
            : 'text',
          escalationPolicy: ['pause', 'retry', 'delegate', 'stop'].includes(
            String(raw.escalationPolicy),
          )
            ? (String(raw.escalationPolicy) as 'pause' | 'retry' | 'delegate' | 'stop')
            : 'pause',
          mode: [
            'plan',
            'execute',
            'review',
            'chat',
            'supervised',
            'autonomous',
            'maintenance',
            'emergency-stop',
            'custom',
          ].includes(String(raw.mode))
            ? (String(raw.mode) as Agent['profile']['mode'])
            : 'supervised',
          version: 1,
          changelog: [],
        } satisfies Agent['profile'];
        const agent = entity({
          kind: 'agent',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          environmentId: environment.id,
          status: 'idle',
          profile,
        }) as Agent;
        await deps.store.insert(agent);
        return send(res, 201, agent);
      }
      const agentMatch = path.match(/^\/api\/v1\/agents\/([^/]+)$/);
      if (agentMatch && req.method === 'PATCH') {
        const agent = await required(
          actorId,
          await deps.store.get<Agent>(agentMatch[1]!),
          'write',
          'agent',
        );
        const body = await parseBody(req);
        const expectedVersion = Number(body.version);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
          throw new Error('agent_version_required');
        const raw =
          body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
            ? (body.profile as Record<string, unknown>)
            : {};
        const list = (value: unknown, fallback: string[] = [], max = 64) =>
          (Array.isArray(value) ? value : fallback)
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.slice(0, 1000))
            .slice(0, max);
        const number = (value: unknown, fallback: number, min: number, max: number) => {
          const parsed = Number(value ?? fallback);
          return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
        };
        const current = agent.profile;
        const profile = {
          ...current,
          name: raw.name === undefined ? current.name : String(raw.name).slice(0, 200),
          description:
            raw.description === undefined
              ? current.description
              : String(raw.description).slice(0, 2000),
          avatar: raw.avatar === undefined ? current.avatar : String(raw.avatar).slice(0, 32),
          mission: raw.mission === undefined ? current.mission : String(raw.mission).slice(0, 4000),
          systemInstructions:
            raw.systemInstructions === undefined
              ? current.systemInstructions
              : String(raw.systemInstructions).slice(0, 12000),
          projectRules:
            raw.projectRules === undefined ? current.projectRules : list(raw.projectRules, []),
          skills: raw.skills === undefined ? current.skills : list(raw.skills, []),
          allowedModels:
            raw.allowedModels === undefined ? current.allowedModels : list(raw.allowedModels),
          preferredModelId:
            raw.preferredModelId === undefined
              ? current.preferredModelId
              : raw.preferredModelId
                ? String(raw.preferredModelId)
                : undefined,
          fallbackModelIds:
            raw.fallbackModelIds === undefined
              ? current.fallbackModelIds
              : list(raw.fallbackModelIds, []),
          allowedToolIds:
            raw.allowedToolIds === undefined ? current.allowedToolIds : list(raw.allowedToolIds),
          allowedPluginIds:
            raw.allowedPluginIds === undefined
              ? current.allowedPluginIds
              : list(raw.allowedPluginIds),
          allowedPaths:
            raw.allowedPaths === undefined ? current.allowedPaths : list(raw.allowedPaths, ['.']),
          protectedPaths:
            raw.protectedPaths === undefined
              ? current.protectedPaths
              : list(raw.protectedPaths, ['.env', '.git']),
          network: ['blocked', 'allowlist', 'open'].includes(String(raw.network))
            ? (String(raw.network) as Agent['profile']['network'])
            : current.network,
          environmentKeys:
            raw.environmentKeys === undefined ? current.environmentKeys : list(raw.environmentKeys),
          maxSteps: number(raw.maxSteps, current.maxSteps, 1, 1000),
          timeLimitMs: number(raw.timeLimitMs, current.timeLimitMs, 1000, 86_400_000),
          tokenLimit: number(raw.tokenLimit, current.tokenLimit, 128, 1_000_000),
          costLimitCents: number(raw.costLimitCents, current.costLimitCents, 0, 1_000_000_000),
          concurrencyLimit: number(raw.concurrencyLimit, current.concurrencyLimit, 1, 32),
          outputFormat: ['text', 'json', 'markdown'].includes(String(raw.outputFormat))
            ? (String(raw.outputFormat) as Agent['profile']['outputFormat'])
            : current.outputFormat,
          escalationPolicy: ['pause', 'retry', 'delegate', 'stop'].includes(
            String(raw.escalationPolicy),
          )
            ? (String(raw.escalationPolicy) as Agent['profile']['escalationPolicy'])
            : current.escalationPolicy,
          mode: [
            'plan',
            'execute',
            'review',
            'chat',
            'supervised',
            'autonomous',
            'maintenance',
            'emergency-stop',
            'custom',
          ].includes(String(raw.mode))
            ? (String(raw.mode) as Agent['profile']['mode'])
            : current.mode,
          version: current.version + 1,
          changelog: [
            ...current.changelog,
            String(body.changeSummary ?? 'Profile updated').slice(0, 500),
          ].slice(-32),
        } satisfies Agent['profile'];
        const saved = await deps.store.putIfVersion(
          { ...agent, profile, version: agent.version } as Agent,
          expectedVersion,
        );
        await deps.store.audit({
          kind: 'audit-event',
          ownerId: actorId,
          scope: agent.projectId,
          actorId,
          action: 'agent.profile.update',
          resourceType: 'agent',
          resourceId: agent.id,
          risk: 'medium',
          decision: 'executed',
          metadata: {
            entityVersion: saved.version,
            profileVersion: saved.profile.version,
            changedFields: Object.keys(raw)
              .filter((key) => key !== 'approvalPolicy' && key !== 'verificationPolicy')
              .slice(0, 64),
          },
        });
        return send(res, 200, saved);
      }
      if (path === '/api/v1/tasks' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Task>((x) => x.kind === 'task')),
        );
      if (path === '/api/v1/tasks' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'write',
          'project',
        );
        const environment = await required(
          actorId,
          await deps.store.get<Environment>(String(body.environmentId)),
          'write',
          'environment',
        );
        if (environment.projectId !== project.id) throw new Error('task_scope_mismatch');
        const assigneeAgentId = body.assigneeAgentId ? String(body.assigneeAgentId) : undefined;
        if (assigneeAgentId) {
          const assignee = await required(
            actorId,
            await deps.store.get<Agent>(assigneeAgentId),
            'write',
            'agent',
          );
          if (assignee.projectId !== project.id) throw new Error('task_assignee_scope_mismatch');
        }
        const parentTaskId = body.parentTaskId ? String(body.parentTaskId) : undefined;
        if (parentTaskId) {
          const parent = await required(
            actorId,
            await deps.store.get<Task>(parentTaskId),
            'write',
            'task',
          );
          if (parent.projectId !== project.id) throw new Error('task_parent_scope_mismatch');
        }
        const dependencyIds = Array.isArray(body.dependencyIds)
          ? body.dependencyIds.map(String).filter(Boolean).slice(0, 64)
          : [];
        for (const dependencyId of dependencyIds) {
          const dependency = await required(
            actorId,
            await deps.store.get<Task>(dependencyId),
            'read',
            'task',
          );
          if (dependency.projectId !== project.id)
            throw new Error('task_dependency_scope_mismatch');
        }
        const status = ['backlog', 'ready', 'blocked'].includes(String(body.status))
          ? (String(body.status) as Task['status'])
          : 'ready';
        const priority = Number(body.priority ?? 0);
        const task = entity({
          kind: 'task',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          environmentId: environment.id,
          title: String(body.title ?? 'Untitled task').slice(0, 500),
          description: String(body.description ?? '').slice(0, 20_000),
          acceptanceCriteria: Array.isArray(body.acceptanceCriteria)
            ? body.acceptanceCriteria
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.slice(0, 2000))
                .slice(0, 64)
            : [],
          status,
          priority: Number.isFinite(priority) ? Math.min(100, Math.max(-100, priority)) : 0,
          ...(assigneeAgentId ? { assigneeAgentId } : {}),
          ...(parentTaskId ? { parentTaskId } : {}),
          dependencyIds,
          labels: Array.isArray(body.labels)
            ? body.labels
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.slice(0, 100))
                .slice(0, 32)
            : [],
        }) as Task;
        await deps.store.insert(task);
        return send(res, 201, task);
      }
      const taskMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (taskMatch && req.method === 'PATCH') {
        const task = await required(
          actorId,
          await deps.store.get<Task>(taskMatch[1]!),
          'write',
          'task',
        );
        const body = await parseBody(req);
        const expectedVersion = Number(body.version);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
          throw new Error('task_version_required');
        const nextStatus = body.status === undefined ? task.status : String(body.status);
        const allowed: Record<Task['status'], Task['status'][]> = {
          backlog: ['backlog', 'ready', 'cancelled'],
          ready: ['ready', 'running', 'blocked', 'cancelled'],
          running: ['running', 'done', 'blocked', 'cancelled'],
          blocked: ['blocked', 'ready', 'cancelled'],
          done: ['done'],
          cancelled: ['cancelled'],
        };
        if (
          !Object.hasOwn(allowed, nextStatus) ||
          !allowed[task.status].includes(nextStatus as Task['status'])
        )
          throw new Error('task_transition_invalid');
        let assigneeAgentId = task.assigneeAgentId;
        if (Object.hasOwn(body, 'assigneeAgentId')) {
          assigneeAgentId = body.assigneeAgentId ? String(body.assigneeAgentId) : undefined;
          if (assigneeAgentId) {
            const assignee = await required(
              actorId,
              await deps.store.get<Agent>(assigneeAgentId),
              'write',
              'agent',
            );
            if (assignee.projectId !== task.projectId)
              throw new Error('task_assignee_scope_mismatch');
          }
        }
        const saved = await deps.store.putIfVersion(
          {
            ...task,
            status: nextStatus as Task['status'],
            title: body.title === undefined ? task.title : String(body.title).slice(0, 500),
            description:
              body.description === undefined
                ? task.description
                : String(body.description).slice(0, 20_000),
            acceptanceCriteria: Array.isArray(body.acceptanceCriteria)
              ? body.acceptanceCriteria
                  .filter((item): item is string => typeof item === 'string')
                  .map((item) => item.slice(0, 2000))
                  .slice(0, 64)
              : task.acceptanceCriteria,
            priority:
              body.priority === undefined
                ? task.priority
                : Number.isFinite(Number(body.priority))
                  ? Math.min(100, Math.max(-100, Number(body.priority)))
                  : task.priority,
            labels: Array.isArray(body.labels)
              ? body.labels
                  .filter((item): item is string => typeof item === 'string')
                  .map((item) => item.slice(0, 100))
                  .slice(0, 32)
              : task.labels,
            ...(assigneeAgentId ? { assigneeAgentId } : { assigneeAgentId: undefined }),
          } as Task,
          expectedVersion,
        );
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
        const authType = String(body.authType ?? 'api-key');
        if (!['api-key', 'env'].includes(authType)) throw new Error('provider_auth_type_invalid');
        const environmentVariable = String(body.environmentVariable ?? '');
        if (authType === 'env' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(environmentVariable))
          throw new Error('provider_environment_variable_invalid');
        if (authType === 'env' && body.token !== undefined)
          throw new Error('provider_environment_secret_must_not_be_submitted');
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
          oauth: parseOAuthConfig(body.oauth),
          ...(authType === 'env'
            ? { credentialSource: { authType: 'env' as const, environmentVariable } }
            : {}),
          enabled: true,
          health: 'unknown',
          capabilities: defaultCapabilities(),
        }) as ModelProvider;
        await deps.store.insert(provider);
        deps.registerProvider?.(provider);
        if (authType === 'env') {
          const credential = entity({
            kind: 'credential',
            ownerId: actorId,
            scope: provider.scope,
            metadata: {
              providerId: provider.id,
              label: `${provider.name} environment credential`,
              authType: 'env' as const,
              scopes: [],
              disabled: false,
              fingerprint: 'environment-reference',
            },
            secretRef: `env:${environmentVariable}`,
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
            metadata: { authType: 'env', environmentVariable },
          });
        } else if (body.token) {
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
      const oauthStart = path.match(/^\/api\/v1\/providers\/([^/]+)\/oauth\/start$/);
      if (oauthStart && req.method === 'POST') {
        if (!deps.oauth) throw new Error('oauth_not_configured');
        const provider = await required(
          actorId,
          await deps.store.get<ModelProvider>(oauthStart[1]!),
          'write',
          'model-provider',
        );
        if (!provider.oauth) throw new Error('oauth_not_configured');
        const body = await parseBody(req);
        const result = deps.oauth.begin({
          actorId,
          providerId: provider.id,
          authorizationEndpoint: provider.oauth.authorizationEndpoint,
          clientId: provider.oauth.clientId,
          redirectUri: provider.oauth.redirectUri,
          scopes: provider.oauth.scopes,
          ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
        });
        return send(res, 200, {
          authorizeUrl: result.authorizationUrl,
          expiresAt: new Date(result.session.expiresAt).toISOString(),
        });
      }
      const deviceStart = path.match(/^\/api\/v1\/providers\/([^/]+)\/device\/start$/);
      if (deviceStart && req.method === 'POST') {
        if (!deps.device) throw new Error('device_authorization_not_configured');
        const provider = await required(
          actorId,
          await deps.store.get<ModelProvider>(deviceStart[1]!),
          'write',
          'model-provider',
        );
        const deviceEndpoint = provider.oauth?.deviceAuthorizationEndpoint;
        if (!provider.oauth || !deviceEndpoint)
          throw new Error('device_authorization_not_configured');
        const endpoint = validateDeviceAuthorizationEndpoint(deviceEndpoint);
        const deviceResponse = await fetchPinned(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: provider.oauth.clientId,
            scope: provider.oauth.scopes.join(' '),
          }).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (!deviceResponse.ok)
          throw new Error(`device_authorization_start_failed:${deviceResponse.status}`);
        const payload = (await deviceResponse.json()) as {
          device_code?: unknown;
          user_code?: unknown;
          verification_uri?: unknown;
          verification_url?: unknown;
          expires_in?: unknown;
          interval?: unknown;
        };
        if (
          typeof payload.device_code !== 'string' ||
          typeof payload.user_code !== 'string' ||
          (typeof payload.verification_uri !== 'string' &&
            typeof payload.verification_url !== 'string')
        )
          throw new Error('device_authorization_response_invalid');
        const result = deps.device.create({
          actorId,
          providerId: provider.id,
          clientId: provider.oauth.clientId,
          deviceCode: payload.device_code,
          userCode: payload.user_code,
          verificationUri: String(payload.verification_uri ?? payload.verification_url),
          expiresInSeconds: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
          intervalSeconds: typeof payload.interval === 'number' ? payload.interval : undefined,
        });
        return send(res, 200, {
          sessionId: result.sessionId,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          expiresAt: new Date(result.expiresAt).toISOString(),
          intervalSeconds: result.intervalSeconds,
        });
      }
      const devicePoll = path.match(/^\/api\/v1\/providers\/([^/]+)\/device\/poll$/);
      if (devicePoll && req.method === 'POST') {
        if (!deps.device) throw new Error('device_authorization_not_configured');
        const provider = await required(
          actorId,
          await deps.store.get<ModelProvider>(devicePoll[1]!),
          'write',
          'model-provider',
        );
        if (!provider.oauth) throw new Error('device_authorization_not_configured');
        const body = await parseBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (!sessionId || sessionId.length > 256) throw new Error('device_session_invalid');
        const session = deps.device.beginPoll(provider.id, actorId, sessionId);
        const tokenEndpoint = new URL(provider.oauth.tokenEndpoint);
        const tokenResponse = await fetchPinned(tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: session.deviceCode,
            client_id: session.clientId,
          }).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (!tokenResponse.ok) {
          let providerError = '';
          try {
            const errorPayload = (await tokenResponse.json()) as { error?: unknown };
            if (typeof errorPayload.error === 'string') providerError = errorPayload.error;
          } catch {
            // Error bodies are intentionally not returned or logged.
          }
          if (providerError === 'authorization_pending')
            return send(res, 202, {
              status: 'pending',
              retryAfterSeconds: session.intervalSeconds,
            });
          if (providerError === 'slow_down') {
            const retryAfterSeconds = deps.device.slowDown(session.sessionId);
            return send(res, 202, { status: 'pending', retryAfterSeconds });
          }
          deps.device.invalidate(session.sessionId);
          if (providerError === 'expired_token') throw new Error('device_authorization_expired');
          if (providerError === 'access_denied') throw new Error('device_authorization_denied');
          throw new Error(`device_token_exchange_failed:${tokenResponse.status}`);
        }
        const tokenPayload = (await tokenResponse.json()) as { access_token?: unknown };
        if (typeof tokenPayload.access_token !== 'string' || tokenPayload.access_token.length < 8) {
          deps.device.invalidate(session.sessionId);
          throw new Error('device_access_token_missing');
        }
        const accessToken = tokenPayload.access_token;
        // Consume the device session before any durable writes so a successful
        // provider exchange cannot be replayed if persistence fails or a
        // concurrent poll arrives after the provider has issued the token.
        deps.device.complete(session.sessionId);
        await deps.vault.set(provider.id, accessToken);
        const existing = provider.credentialId
          ? await deps.store.get<Credential>(provider.credentialId)
          : undefined;
        const metadata = {
          providerId: provider.id,
          label: `${provider.name} device credential`,
          authType: 'device' as const,
          scopes: provider.oauth.scopes,
          disabled: false,
          lastTestedAt: now(),
          fingerprint: fingerprint(accessToken),
        };
        const credential = existing
          ? await deps.store.put({ ...existing, metadata, version: existing.version } as Credential)
          : ((await deps.store.insert(
              entity({
                kind: 'credential',
                ownerId: actorId,
                scope: provider.scope,
                metadata,
                secretRef: provider.id,
              }) as Credential,
            )) as Credential);
        const saved = await deps.store.put({
          ...provider,
          credentialId: credential.id,
          version: provider.version,
        } as ModelProvider);
        deps.registerProvider?.(saved);
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
          metadata: { authType: 'device', scopes: provider.oauth.scopes },
        });
        return send(res, 200, {
          provider: saved,
          credential: { id: credential.id, metadata: credential.metadata },
        });
      }
      const providerTest = path.match(/^\/api\/v1\/providers\/([^/]+)\/test$/);
      if (providerTest && req.method === 'POST') {
        const provider = await required(
          actorId,
          await deps.store.get<ModelProvider>(providerTest[1]!),
          'write',
          'model-provider',
        );
        const health = await adapterFor(
          provider,
          resolveProviderToken(provider, deps.vault.getSync(provider.id)),
        ).health();
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
        const inputCostPerMillionCents = Number(body.inputCostPerMillionCents ?? 0);
        const outputCostPerMillionCents = Number(body.outputCostPerMillionCents ?? 0);
        const latencyMs = body.latencyMs === undefined ? undefined : Number(body.latencyMs);
        const routingWeight =
          body.routingWeight === undefined ? undefined : Number(body.routingWeight);
        if (
          !Number.isFinite(inputCostPerMillionCents) ||
          !Number.isFinite(outputCostPerMillionCents) ||
          inputCostPerMillionCents < 0 ||
          outputCostPerMillionCents < 0 ||
          inputCostPerMillionCents > 1_000_000_000 ||
          outputCostPerMillionCents > 1_000_000_000 ||
          (latencyMs !== undefined && (!Number.isFinite(latencyMs) || latencyMs < 0)) ||
          (routingWeight !== undefined && (!Number.isFinite(routingWeight) || routingWeight < 0))
        )
          throw new Error('model_metadata_invalid');
        const model = entity({
          kind: 'model',
          ownerId: actorId,
          scope: provider.scope,
          providerId: provider.id,
          name: String(body.name ?? body.modelName),
          modelName: String(body.modelName),
          local: Boolean(body.local),
          capabilities: { ...defaultCapabilities(), ...((body.capabilities as object) ?? {}) },
          inputCostPerMillionCents,
          outputCostPerMillionCents,
          ...(latencyMs === undefined ? {} : { latencyMs }),
          ...(routingWeight === undefined ? {} : { routingWeight }),
          available: true,
        });
        await deps.store.insert(model);
        return send(res, 201, model);
      }
      if (path === '/api/v1/model-routes' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<ModelRoute>((x) => x.kind === 'model-route'),
          ),
        );
      if (path === '/api/v1/model-routes' && req.method === 'POST') {
        const body = await parseBody(req);
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const agentId = body.agentId ? String(body.agentId) : undefined;
        const project = projectId
          ? await required(actorId, await deps.store.get<Project>(projectId), 'write', 'project')
          : undefined;
        const agent = agentId
          ? await required(actorId, await deps.store.get<Agent>(agentId), 'write', 'agent')
          : undefined;
        if (project && agent && agent.projectId !== project.id)
          throw new Error('model_route_scope_mismatch');
        const strategy = String(body.strategy ?? 'health-first') as ModelRoute['strategy'];
        if (
          ![
            'manual',
            'weighted',
            'least-cost',
            'lowest-latency',
            'privacy-first',
            'health-first',
          ].includes(strategy)
        )
          throw new Error('model_route_strategy_invalid');
        const modelIds = Array.isArray(body.modelIds)
          ? body.modelIds.map(String).filter(Boolean).slice(0, 64)
          : [];
        const fallbackModelIds = Array.isArray(body.fallbackModelIds)
          ? body.fallbackModelIds.map(String).filter(Boolean).slice(0, 64)
          : [];
        if (!modelIds.length && !fallbackModelIds.length)
          throw new Error('model_route_models_required');
        const routeScopeIds = [
          project?.id,
          project?.workspaceId,
          agent?.projectId,
          agent?.scope,
        ].filter((value): value is string => Boolean(value));
        for (const modelId of [...new Set([...modelIds, ...fallbackModelIds])]) {
          const model = await required(
            actorId,
            await deps.store.get<Model>(modelId),
            'read',
            'model',
          );
          if (routeScopeIds.length && !routeScopeIds.includes(model.scope))
            throw new Error('model_route_model_scope_mismatch');
        }
        const maxCostCents =
          body.maxCostCents === undefined ? undefined : Number(body.maxCostCents);
        if (
          maxCostCents !== undefined &&
          (!Number.isFinite(maxCostCents) || maxCostCents > 1_000_000_000)
        )
          throw new Error('model_route_cost_invalid');
        const route = entity({
          kind: 'model-route',
          ownerId: actorId,
          scope: project?.id ?? agent?.scope ?? 'workspace_local',
          projectId,
          agentId,
          name: String(body.name ?? 'Model route'),
          strategy,
          modelIds,
          fallbackModelIds,
          offlineOnly: Boolean(body.offlineOnly),
          ...(maxCostCents === undefined ? {} : { maxCostCents: Math.max(0, maxCostCents) }),
        }) as ModelRoute;
        await deps.store.insert(route);
        return send(res, 201, route);
      }
      if (path === '/api/v1/budgets' && req.method === 'GET') {
        const budgets = await visible(
          actorId,
          await deps.store.list<Budget>((x) => x.kind === 'budget'),
        );
        const usage = await deps.store.list<UsageRecord>((x) => x.kind === 'usage');
        const costs = await deps.store.list<CostRecord>((x) => x.kind === 'cost');
        return send(
          res,
          200,
          budgets.map((budget) => ({
            ...budget,
            status: budgetStatus(budget, { usage, costs }),
          })),
        );
      }
      if (path === '/api/v1/budgets' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'write',
          'project',
        );
        const agentId = body.agentId ? String(body.agentId) : undefined;
        if (agentId) {
          const agent = await required(
            actorId,
            await deps.store.get<Agent>(agentId),
            'write',
            'agent',
          );
          if (agent.projectId !== project.id) throw new Error('budget_scope_mismatch');
        }
        const period = String(body.period ?? 'monthly') as BudgetPeriod;
        if (!['daily', 'monthly', 'lifetime'].includes(period))
          throw new Error('budget_period_invalid');
        const limitCents = Number(body.limitCents);
        if (!Number.isFinite(limitCents) || limitCents <= 0 || limitCents > 1_000_000_000)
          throw new Error('budget_limit_invalid');
        const warnRatio = body.warnRatio === undefined ? 0.8 : Number(body.warnRatio);
        if (!Number.isFinite(warnRatio) || warnRatio < 0 || warnRatio > 1)
          throw new Error('budget_warn_ratio_invalid');
        const budget = entity({
          kind: 'budget',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          agentId,
          name: String(body.name ?? 'Budget').slice(0, 200),
          period,
          limitCents,
          warnRatio,
          enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        }) as Budget;
        await deps.store.insert(budget);
        await deps.store.audit({
          kind: 'audit-event',
          ownerId: actorId,
          scope: project.id,
          actorId,
          action: 'budget.created',
          resourceType: 'budget',
          resourceId: budget.id,
          risk: 'medium',
          decision: 'executed',
          metadata: { period, limitCents, agentScoped: Boolean(agentId) },
        });
        return send(res, 201, budget);
      }
      if (path === '/api/v1/budgets/estimate' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'read',
          'project',
        );
        const model = await required(
          actorId,
          await deps.store.get<Model>(String(body.modelId)),
          'read',
          'model',
        );
        const inputTokens = Number(body.inputTokens ?? 0);
        const outputTokens = Number(body.outputTokens ?? 0);
        if (
          !Number.isFinite(inputTokens) ||
          !Number.isFinite(outputTokens) ||
          inputTokens < 0 ||
          outputTokens < 0 ||
          inputTokens > 100_000_000 ||
          outputTokens > 100_000_000
        )
          throw new Error('budget_estimate_tokens_invalid');
        const agentId = body.agentId ? String(body.agentId) : undefined;
        const estimatedCostCents = estimateCostCents(model, inputTokens, outputTokens);
        if (agentId) {
          const agent = await required(
            actorId,
            await deps.store.get<Agent>(agentId),
            'read',
            'agent',
          );
          if (agent.projectId !== project.id) throw new Error('budget_scope_mismatch');
        }
        const budgets = await deps.store.list<Budget>(
          (x) => x.kind === 'budget' && (x as Budget).projectId === project.id,
        );
        const usage = await deps.store.list<UsageRecord>((x) => x.kind === 'usage');
        const costs = await deps.store.list<CostRecord>((x) => x.kind === 'cost');
        const decision = evaluateBudgets(
          budgets,
          { projectId: project.id, agentId },
          { usage, costs },
          estimatedCostCents,
        );
        return send(res, 200, {
          modelId: model.id,
          inputTokens,
          outputTokens,
          estimatedCostCents,
          allowed: decision.allowed,
          blockedBy: decision.blockedBy,
          warnings: decision.warnings,
          budgets: decision.statuses,
        });
      }
      if (path === '/api/v1/artifacts' && req.method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<Artifact>(
              (x) =>
                x.kind === 'artifact' && (!projectId || (x as Artifact).projectId === projectId),
            ),
          ),
        );
      }
      if (path === '/api/v1/artifacts' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'write',
          'project',
        );
        const content = String(body.content ?? '');
        const scan = scanArtifact(content);
        if (scan.status === 'blocked') throw new Error(scan.reasons[0] ?? 'artifact_blocked');
        const runId = body.runId ? String(body.runId) : undefined;
        if (runId) {
          const run = await required(actorId, await deps.store.get<Run>(runId), 'read', 'run');
          if (run.projectId !== project.id) throw new Error('artifact_scope_mismatch');
        }
        const artifact = entity({
          kind: 'artifact',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          runId,
          name: String(body.name ?? 'artifact').slice(0, 200),
          path: String(body.path ?? `artifacts/${String(body.name ?? 'artifact')}`).slice(0, 400),
          mimeType: String(body.mimeType ?? 'text/plain').slice(0, 120),
          size: Buffer.byteLength(content, 'utf8'),
          sha256: sha256(content),
          scanStatus: scan.status,
        }) as Artifact;
        await deps.store.insert(artifact);
        await deps.store.audit({
          kind: 'audit-event',
          ownerId: actorId,
          scope: project.id,
          actorId,
          action: 'artifact.registered',
          resourceType: 'artifact',
          resourceId: artifact.id,
          risk: 'low',
          decision: 'executed',
          metadata: {
            size: artifact.size,
            sha256: artifact.sha256,
            scanStatus: artifact.scanStatus,
          },
        });
        return send(res, 201, artifact);
      }
      if (path === '/api/v1/workflows' && req.method === 'GET') {
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Workflow>((x) => x.kind === 'workflow')),
        );
      }
      if (path === '/api/v1/workflows' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'write',
          'project',
        );
        const nodes = Array.isArray(body.nodes) ? (body.nodes as WorkflowNode[]) : [];
        const edges = Array.isArray(body.edges) ? (body.edges as WorkflowEdge[]) : [];
        const validation = validateWorkflow(nodes, edges);
        if (!validation.valid) throw new Error(validation.errors[0] ?? 'workflow_invalid');
        const workflow = entity({
          kind: 'workflow',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          name: String(body.name ?? 'Workflow').slice(0, 200),
          description: String(body.description ?? '').slice(0, 2000),
          nodes: nodes.map((node) => ({
            id: String(node.id).slice(0, 120),
            kind: node.kind,
            config: (node.config ?? {}) as Record<string, unknown>,
          })),
          edges: edges.map((item) => ({
            from: String(item.from).slice(0, 120),
            to: String(item.to).slice(0, 120),
            condition: item.condition ? String(item.condition).slice(0, 500) : undefined,
          })),
          enabled: false,
        }) as Workflow;
        await deps.store.insert(workflow);
        await deps.store.audit({
          kind: 'audit-event',
          ownerId: actorId,
          scope: project.id,
          actorId,
          action: 'workflow.created',
          resourceType: 'workflow',
          resourceId: workflow.id,
          risk: 'medium',
          decision: 'executed',
          metadata: { nodes: workflow.nodes.length, edges: workflow.edges.length },
        });
        return send(res, 201, { ...workflow, validation });
      }
      if (path === '/api/v1/usage' && req.method === 'GET') {
        const grouping = (url.searchParams.get('groupBy') ?? 'project') as CostGrouping;
        if (!['project', 'agent', 'model', 'run'].includes(grouping))
          throw new Error('usage_grouping_invalid');
        const period = url.searchParams.get('period') ?? 'monthly';
        if (!['daily', 'monthly', 'lifetime'].includes(period))
          throw new Error('usage_period_invalid');
        const projectParam = url.searchParams.get('projectId');
        if (projectParam)
          await required(actorId, await deps.store.get<Project>(projectParam), 'read', 'project');
        const visibleProjects = new Set(
          (await visible(actorId, await deps.store.list<Project>((x) => x.kind === 'project'))).map(
            (project) => project.id,
          ),
        );
        const usage = (await deps.store.list<UsageRecord>((x) => x.kind === 'usage')).filter(
          (record) => visibleProjects.has(record.projectId),
        );
        const costs = (await deps.store.list<CostRecord>((x) => x.kind === 'cost')).filter(
          (record) => visibleProjects.has(record.projectId),
        );
        const report = costReport(usage, costs, grouping, {
          period: period as 'daily' | 'monthly' | 'lifetime',
          projectId: projectParam ?? undefined,
        });
        return send(res, 200, {
          ...report,
          forecastCents: forecastCents(report.totalCostCents, report.window),
        });
      }
      if (path === '/api/v1/alerts' && req.method === 'GET') {
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Alert>((x) => x.kind === 'alert')),
        );
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
      const memoryApproval = path.match(/^\/api\/v1\/memory\/([^/]+)\/approval$/);
      if (memoryApproval && req.method === 'POST') {
        const memory = await required(
          actorId,
          await deps.store.get<MemoryItem>(memoryApproval[1]!),
          'write',
          'memory',
        );
        const body = await parseBody(req);
        if (typeof body.approved !== 'boolean' || typeof body.version !== 'number')
          throw new Error('memory_approval_input_invalid');
        const saved = await deps.store.putIfVersion(
          { ...memory, approved: body.approved },
          body.version,
        );
        await deps.store.audit({
          kind: 'audit-event',
          ownerId: actorId,
          scope: memory.scope,
          actorId,
          action: body.approved ? 'memory.approved' : 'memory.rejected',
          resourceType: 'memory',
          resourceId: memory.id,
          risk: 'medium',
          decision: 'executed',
          metadata: { approved: body.approved, version: saved.version },
        });
        return send(res, 200, saved);
      }
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
      if (path === '/api/v1/schedules' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Schedule>((x) => x.kind === 'schedule')),
        );
      if (path === '/api/v1/schedules' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'write',
          'project',
        );
        const task = await required(
          actorId,
          await deps.store.get<Task>(String(body.taskId)),
          'write',
          'task',
        );
        if (task.projectId !== project.id) throw new Error('schedule_project_mismatch');
        const cron = String(body.cron ?? '');
        if (cron.length > 128 || !cron.trim()) throw new Error('schedule_cron_invalid');
        const schedule = entity({
          kind: 'schedule',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          cron,
          taskId: task.id,
          enabled: false,
          timezone: String(body.timezone ?? 'UTC'),
        }) as Schedule;
        await deps.store.insert(schedule);
        return send(res, 201, schedule);
      }
      const scheduleMatch = path.match(/^\/api\/v1\/schedules\/([^/]+)\/(enable|disable)$/);
      if (scheduleMatch && req.method === 'POST') {
        const schedule = await required(
          actorId,
          await deps.store.get<Schedule>(scheduleMatch[1]!),
          'write',
          'schedule',
        );
        const body = await parseBody(req);
        const expectedVersion = Number(body.version);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
          throw new Error('schedule_version_required');
        return send(
          res,
          200,
          await deps.store.putIfVersion(
            {
              ...schedule,
              enabled: scheduleMatch[2] === 'enable',
              version: schedule.version,
            } as Schedule,
            expectedVersion,
          ),
        );
      }
      if (path === '/api/v1/webhooks' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(actorId, await deps.store.list<Webhook>((x) => x.kind === 'webhook')),
        );
      if (path === '/api/v1/webhooks' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = await required(
          actorId,
          await deps.store.get<Project>(String(body.projectId)),
          'admin',
          'project',
        );
        const url = String(body.url ?? '');
        assertSafeEndpoint(url);
        const secret = String(body.secret ?? '');
        if (secret.length < 32) throw new Error('webhook_secret_required');
        const webhook = entity({
          kind: 'webhook',
          ownerId: actorId,
          scope: project.id,
          projectId: project.id,
          url,
          events: Array.isArray(body.events) ? body.events.map(String).slice(0, 50) : [],
          secretFingerprint: fingerprint(secret),
          enabled: false,
        }) as Webhook;
        await deps.vault.set(`webhook:${webhook.id}`, secret);
        await deps.store.insert(webhook);
        return send(res, 201, webhook);
      }
      const webhookMatch = path.match(/^\/api\/v1\/webhooks\/([^/]+)\/(enable|disable)$/);
      if (webhookMatch && req.method === 'POST') {
        const webhook = await required(
          actorId,
          await deps.store.get<Webhook>(webhookMatch[1]!),
          'admin',
          'webhook',
        );
        const body = await parseBody(req);
        const expectedVersion = Number(body.version);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
          throw new Error('webhook_version_required');
        return send(
          res,
          200,
          await deps.store.putIfVersion(
            {
              ...webhook,
              enabled: webhookMatch[2] === 'enable',
              version: webhook.version,
            } as Webhook,
            expectedVersion,
          ),
        );
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
      if (path === '/api/v1/evaluations/runs' && req.method === 'GET')
        return send(
          res,
          200,
          await visible(
            actorId,
            await deps.store.list<EvaluationRun>((x) => x.kind === 'evaluation-run'),
          ),
        );
      if (path === '/api/v1/evaluations/runs' && req.method === 'POST') {
        const body = await parseBody(req);
        const dataset = await required(
          actorId,
          await deps.store.get<EvaluationDataset>(String(body.datasetId)),
          'read',
          'evaluation-dataset',
        );
        const cases = await visible(
          actorId,
          await deps.store.list<EvaluationCase>(
            (x) => x.kind === 'evaluation-case' && x.datasetId === dataset.id,
          ),
        );
        if (body.modelId)
          await required(
            actorId,
            await deps.store.get<Model>(String(body.modelId)),
            'read',
            'model',
          );
        if (body.agentId)
          await required(
            actorId,
            await deps.store.get<Agent>(String(body.agentId)),
            'read',
            'agent',
          );
        const outputs =
          body.outputs && typeof body.outputs === 'object' && !Array.isArray(body.outputs)
            ? (body.outputs as Record<string, unknown>)
            : {};
        const startedAt = now();
        const results = evaluateCases(cases, outputs);
        const baselineRunId = body.baselineRunId ? String(body.baselineRunId) : undefined;
        let regression = undefined as ReturnType<typeof compareToBaseline> | undefined;
        let gate = undefined as ReturnType<typeof releaseGate> | undefined;
        if (baselineRunId) {
          const baseline = await required(
            actorId,
            await deps.store.get<EvaluationRun>(baselineRunId),
            'read',
            'evaluation-run',
          );
          if (baseline.datasetId !== dataset.id) throw new Error('evaluation_baseline_mismatch');
          regression = compareToBaseline(results, baseline.results);
          const floor = body.minimumPassRate === undefined ? 1 : Number(body.minimumPassRate);
          if (!Number.isFinite(floor) || floor < 0 || floor > 1)
            throw new Error('evaluation_pass_rate_invalid');
          gate = releaseGate(regression, floor);
        }
        const evaluationRun = entity({
          kind: 'evaluation-run',
          ownerId: actorId,
          scope: dataset.scope,
          datasetId: dataset.id,
          modelId: body.modelId ? String(body.modelId) : undefined,
          agentId: body.agentId ? String(body.agentId) : undefined,
          status: 'completed' as const,
          results,
          startedAt,
          finishedAt: now(),
        }) as EvaluationRun;
        await deps.store.insert(evaluationRun);
        if (regression)
          await deps.store.audit({
            kind: 'audit-event',
            ownerId: actorId,
            scope: dataset.scope,
            actorId,
            action: 'evaluation.gate',
            resourceType: 'evaluation-run',
            resourceId: evaluationRun.id,
            risk: gate?.allowed ? 'low' : 'high',
            decision: gate?.allowed ? 'allowed' : 'denied',
            metadata: {
              baselineRunId,
              regressions: regression.regressions.length,
              missing: regression.missing.length,
              passRate: regression.passRate,
            },
          });
        return send(res, 201, { ...evaluationRun, regression, gate });
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
      const manifestMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/artifact-manifest$/);
      if (manifestMatch && req.method === 'GET') {
        const project = await required(
          actorId,
          await deps.store.get<Project>(manifestMatch[1]!),
          'read',
          'project',
        );
        const artifacts = await visible(
          actorId,
          await deps.store.list<Artifact>(
            (x) => x.kind === 'artifact' && (x as Artifact).projectId === project.id,
          ),
        );
        return send(res, 200, checkpointManifest(project.id, artifacts, now()));
      }
      const workflowPlanMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)\/plan$/);
      if (workflowPlanMatch && req.method === 'GET') {
        const workflow = await required(
          actorId,
          await deps.store.get<Workflow>(workflowPlanMatch[1]!),
          'read',
          'workflow',
        );
        const idList = (name: string): Set<string> =>
          new Set(
            (url.searchParams.get(name) ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
          );
        const completed = idList('completed');
        const failed = idList('failed');
        const known = new Set(workflow.nodes.map((node) => node.id));
        for (const nodeId of [...completed, ...failed])
          if (!known.has(nodeId)) throw new Error('workflow_node_unknown');
        return send(res, 200, {
          workflowId: workflow.id,
          levels: workflowLevels(workflow.nodes, workflow.edges),
          ready: readyNodes(workflow, completed, failed),
          completed: [...completed],
          failed: [...failed],
        });
      }
      const traceMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/trace$/);
      if (traceMatch && req.method === 'GET') {
        const run = await required(
          actorId,
          await deps.store.get<Run>(traceMatch[1]!),
          'read',
          'run',
        );
        const steps = await deps.store.list<RunStep>(
          (x) => x.kind === 'run-step' && (x as RunStep).runId === run.id,
        );
        return send(res, 200, runToOtlp(run, steps));
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
