import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { JsonStateStore } from './store.js';
import {
  Agent,
  ApprovalRequest,
  Checkpoint,
  Credential,
  EvaluationCase,
  EvaluationDataset,
  MemoryItem,
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
const parseBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('invalid_json');
  }
};

export function createApi(deps: ApiDeps) {
  const subscribers = new Set<ServerResponse>();
  deps.orchestrator.on('run', (event) => {
    const data = `data: ${JSON.stringify(redactSecrets(event))}\n\n`;
    for (const res of subscribers) res.write(data);
  });
  return createServer(async (req, res) => {
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
    const actorId = String(req.headers['x-bot-buffet-user'] ?? 'local-user');
    if (process.env.BOT_BUFFET_AUTH_MODE === 'production') {
      const expected = process.env.BOT_BUFFET_API_TOKEN;
      const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!expected || !presented || fingerprint(expected) !== fingerprint(presented)) {
        send(res, 401, { code: 'unauthorized' });
        return;
      }
    }
    try {
      if (path === '/healthz')
        return send(res, 200, { status: 'ok', service: 'bot-buffet', time: now() });
      if (path === '/readyz')
        return send(res, 200, {
          status: 'ready',
          storage: 'durable-json',
          auth: process.env.BOT_BUFFET_AUTH_MODE ?? 'development',
        });
      if (path === '/events' && req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
        subscribers.add(res);
        req.on('close', () => subscribers.delete(res));
        return;
      }
      if (path === '/api/v1/bootstrap' && req.method === 'GET')
        return send(res, 200, {
          workspaces: await deps.store.list<Workspace>((x) => x.kind === 'workspace'),
          projects: await deps.store.list<Project>(
            (x) => x.kind === 'project' && !(x as Project).archived,
          ),
          agents: await deps.store.list<Agent>((x) => x.kind === 'agent'),
          tasks: await deps.store.list<Task>((x) => x.kind === 'task'),
          runs: await deps.store.list((x) => x.kind === 'run'),
          models: await deps.store.list<Model>((x) => x.kind === 'model'),
          providers: await deps.store.list<ModelProvider>((x) => x.kind === 'model-provider'),
          approvals: await deps.store.list<ApprovalRequest>(
            (x) => x.kind === 'approval-request' && (x as ApprovalRequest).status === 'pending',
          ),
          plugins: await deps.store.list<Plugin>((x) => x.kind === 'plugin'),
          audit: await deps.store.list((x) => x.kind === 'audit-event'),
        });
      if (path === '/api/v1/projects' && req.method === 'GET')
        return send(res, 200, await deps.store.list<Project>((x) => x.kind === 'project'));
      if (path === '/api/v1/projects' && req.method === 'POST') {
        const body = await parseBody(req);
        const project = entity({
          kind: 'project',
          ownerId: actorId,
          scope: String(body.workspaceId ?? 'workspace_local'),
          workspaceId: String(body.workspaceId ?? 'workspace_local'),
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
        const project = await deps.store.get<Project>(projectMatch[1]!);
        if (!project) return send(res, 404, { code: 'not_found' });
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
          await deps.store.list<ModelProvider>((x) => x.kind === 'model-provider'),
        );
      if (path === '/api/v1/providers' && req.method === 'POST') {
        const body = await parseBody(req);
        assertSafeEndpoint(String(body.endpoint ?? 'http://127.0.0.1:11434/v1'));
        let provider = entity({
          kind: 'model-provider',
          ownerId: actorId,
          scope: String(body.scope ?? 'workspace_local'),
          name: String(body.name ?? body.providerKind ?? 'Provider'),
          providerKind: String(
            body.providerKind ?? 'openai-compatible',
          ) as ModelProvider['providerKind'],
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
        const provider = await deps.store.get<ModelProvider>(providerTest[1]!);
        if (!provider) return send(res, 404, { code: 'not_found' });
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
        const provider = await deps.store.get<ModelProvider>(providerDelete[1]!);
        if (!provider) return send(res, 404, { code: 'not_found' });
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
        return send(res, 200, await deps.store.list<Credential>((x) => x.kind === 'credential'));
      if (path === '/api/v1/models' && req.method === 'GET')
        return send(res, 200, await deps.store.list<Model>((x) => x.kind === 'model'));
      if (path === '/api/v1/models' && req.method === 'POST') {
        const body = await parseBody(req);
        const model = entity({
          kind: 'model',
          ownerId: actorId,
          scope: String(body.scope ?? 'workspace_local'),
          providerId: String(body.providerId),
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
          await deps.store.list<MemoryItem>(
            (x) =>
              x.kind === 'memory' &&
              (!namespace || (x as MemoryItem).namespace === namespace) &&
              (!namespaceId || (x as MemoryItem).namespaceId === namespaceId),
          ),
        );
      }
      if (path === '/api/v1/memory' && req.method === 'POST') {
        const body = await parseBody(req);
        const memory = entity({
          kind: 'memory',
          ownerId: actorId,
          scope: String(body.scope ?? body.namespaceId ?? 'project_local'),
          namespace: String(body.namespace ?? 'project') as MemoryItem['namespace'],
          namespaceId: String(body.namespaceId ?? body.scope ?? 'project_local'),
          text: String(body.text ?? ''),
          data: body.data as Record<string, unknown> | undefined,
          sourceIds: [],
          approved: Boolean(body.approved),
          freshnessAt: now(),
          expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
        }) as MemoryItem;
        await deps.store.insert(memory);
        return send(res, 201, memory);
      }
      const memoryMatch = path.match(/^\/api\/v1\/memory\/([^/]+)$/);
      if (memoryMatch && req.method === 'DELETE') {
        await deps.store.delete(memoryMatch[1]!);
        return send(res, 204, { deleted: true });
      }
      if (path === '/api/v1/plugins' && req.method === 'GET')
        return send(res, 200, await deps.store.list<Plugin>((x) => x.kind === 'plugin'));
      if (path === '/api/v1/plugins' && req.method === 'POST') {
        const body = await parseBody(req);
        const plugin = entity({
          kind: 'plugin',
          ownerId: actorId,
          scope: String(body.scope ?? 'workspace_local'),
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
        const plugin = await deps.store.get<Plugin>(pluginMatch[1]!);
        if (!plugin) return send(res, 404, { code: 'not_found' });
        const enabled = pluginMatch[2] === 'enable';
        const saved = await deps.store.put({
          ...plugin,
          enabled,
          workspaceEnabled: enabled,
          version: plugin.version,
        } as Plugin);
        return send(res, 200, saved);
      }
      if (path === '/api/v1/files' && req.method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        return send(
          res,
          200,
          await deps.store.list<ProjectFile>(
            (x) => x.kind === 'file' && (!projectId || (x as ProjectFile).projectId === projectId),
          ),
        );
      }
      if (path === '/api/v1/sources' && req.method === 'GET')
        return send(res, 200, await deps.store.list<Source>((x) => x.kind === 'source'));
      if (path === '/api/v1/sources' && req.method === 'POST') {
        const body = await parseBody(req);
        const uri = String(body.uri ?? '');
        assertSafeEndpoint(uri);
        const source = entity({
          kind: 'source',
          ownerId: actorId,
          scope: String(body.projectId ?? 'project_local'),
          projectId: String(body.projectId ?? 'project_local'),
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
          await deps.store.list<EvaluationDataset>((x) => x.kind === 'evaluation-dataset'),
        );
      if (path === '/api/v1/evaluations/datasets' && req.method === 'POST') {
        const body = await parseBody(req);
        const dataset = entity({
          kind: 'evaluation-dataset',
          ownerId: actorId,
          scope: String(body.scope ?? 'workspace_local'),
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
        const evaluationCase = entity({
          kind: 'evaluation-case',
          ownerId: actorId,
          scope: String(body.datasetId ?? 'dataset_local'),
          datasetId: String(body.datasetId ?? 'dataset_local'),
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
        const runs = await deps.store.list<Run>((x) => x.kind === 'run');
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
      if (replayMatch && req.method === 'GET')
        return send(
          res,
          200,
          await deps.store.list<Checkpoint>(
            (x) => x.kind === 'checkpoint' && (x as Checkpoint).runId === replayMatch[1]!,
          ),
        );
      const exportMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/export$/);
      if (exportMatch && req.method === 'GET') {
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
        const run = await deps.orchestrator.createRun({
          ownerId: actorId,
          project,
          agent,
          task,
          mode: body.mode as never,
        });
        void deps.orchestrator.start(run.id);
        return send(res, 202, run);
      }
      if (path === '/api/v1/runs' && req.method === 'GET')
        return send(res, 200, await deps.store.list((x) => x.kind === 'run'));
      const runMatch = path.match(
        /^\/api\/v1\/runs\/([^/]+)\/(pause|resume|cancel|stop|fork|rollback)$/,
      );
      if (runMatch && req.method === 'POST') {
        const body = await parseBody(req);
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
          await deps.store.list<ApprovalRequest>(
            (x) => x.kind === 'approval-request' && (x as ApprovalRequest).status === 'pending',
          ),
        );
      const approvalMatch = path.match(/^\/api\/v1\/approvals\/([^/]+)$/);
      if (approvalMatch && req.method === 'POST') {
        const approval = await deps.store.get<ApprovalRequest>(approvalMatch[1]!);
        if (!approval) return send(res, 404, { code: 'not_found' });
        const body = await parseBody(req);
        const status = body.approved ? ('approved' as const) : ('rejected' as const);
        const saved = await deps.store.put({
          ...approval,
          status,
          decidedBy: actorId,
          decidedAt: now(),
          reason: body.reason ? String(body.reason) : undefined,
          version: approval.version,
        } as ApprovalRequest);
        if (status === 'approved')
          await deps.orchestrator.command({ runId: approval.runId, type: 'resume' });
        else {
          const run = await deps.store.get<Run>(approval.runId);
          if (run)
            await deps.store.put({
              ...run,
              status: 'blocked',
              error: 'approval_rejected',
              finishedAt: now(),
              version: run.version,
            } as Run);
        }
        return send(res, 200, saved);
      }
      if (path === '/api/v1/audit' && req.method === 'GET')
        return send(res, 200, await deps.store.list((x) => x.kind === 'audit-event'));
      if (path === '/api/v1/audit/verify' && req.method === 'GET')
        return send(res, 200, await deps.store.verifyAuditChain());
      if (path === '/api/v1/stop-all' && req.method === 'POST') {
        const runs = await deps.store.list<Run>(
          (x) =>
            x.kind === 'run' &&
            ['queued', 'running', 'waiting_approval', 'paused', 'retrying'].includes(
              (x as { status: string }).status,
            ),
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
      send(res, 400, {
        code: 'request_failed',
        message: redactSecrets((error as Error).message) as string,
      });
    }
  });
}
