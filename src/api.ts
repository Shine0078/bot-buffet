import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { JsonStateStore } from './store.js';
import {
  Agent,
  ApprovalRequest,
  Model,
  ModelProvider,
  Project,
  Run,
  Task,
  Workspace,
  entity,
  now,
} from './types.js';
import { Orchestrator } from './orchestrator.js';
import { defaultCapabilities } from './providers.js';
import { assertWorkspacePath, redactSecrets, fingerprint } from './security.js';

export interface ApiDeps {
  store: JsonStateStore;
  orchestrator: Orchestrator;
  uiRoot: string;
}
const send = (res: ServerResponse, status: number, payload: unknown): void => {
  res.statusCode = status;
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
        const provider = entity({
          kind: 'model-provider',
          ownerId: actorId,
          scope: String(body.scope ?? 'workspace_local'),
          name: String(body.name ?? body.providerKind ?? 'Provider'),
          providerKind: String(
            body.providerKind ?? 'openai-compatible',
          ) as ModelProvider['providerKind'],
          endpoint: String(body.endpoint ?? 'http://127.0.0.1:11434/v1'),
          credentialId: body.token ? `cred_${fingerprint(String(body.token))}` : undefined,
          enabled: true,
          health: 'unknown',
          capabilities: defaultCapabilities(),
        });
        await deps.store.insert(provider);
        if (body.token)
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
        return send(res, 201, provider);
      }
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
