import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.js';
import { CredentialVault } from '../src/secrets.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ModelRouter } from '../src/router.js';
import { MockLocalAdapter } from '../src/providers.js';
import { createBuiltinTools } from '../src/tools.js';
import { entity, type ApprovalRequest, type Run } from '../src/types.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';

/**
 * The approval workflow and the emergency stop.
 *
 * These are the two controls a human reaches for when an agent is doing
 * something they did not want, so the cases that matter are the ones where a
 * decision must be refused: an approval that already expired, one already
 * decided, and one whose run belongs somewhere else.
 */

const servers: Array<ReturnType<typeof createApi>> = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-approvals-'));
  await writeFile(join(dir, 'repository'), 'contents');
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

  const run = await orchestrator.createRun({ ownerId: 'local-user', project, agent, task });
  return { base: `http://127.0.0.1:${address.port}`, store, run, project };
}

const approvalFor = (
  run: Run,
  projectId: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest =>
  entity({
    kind: 'approval-request',
    ownerId: 'local-user',
    scope: projectId,
    runId: run.id,
    stepId: 'step-1',
    action: 'filesystem.write',
    risk: 'medium',
    payload: { path: 'notes.md' },
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }) as ApprovalRequest;

const decide = (base: string, id: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/v1/approvals/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('listing approvals', () => {
  it('returns only pending requests', async () => {
    const { base, store, run, project } = await start();
    await store.insert(approvalFor(run, project.id));
    await store.insert(approvalFor(run, project.id, { status: 'approved' }));
    await store.insert(approvalFor(run, project.id, { status: 'rejected' }));

    const listed = (await (await fetch(`${base}/api/v1/approvals`)).json()) as ApprovalRequest[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('pending');
  });

  it('returns an empty list rather than failing when there are none', async () => {
    const { base } = await start();
    await expect((await fetch(`${base}/api/v1/approvals`)).json()).resolves.toEqual([]);
  });
});

describe('deciding an approval', () => {
  it('records who approved it and when', async () => {
    const { base, store, run, project } = await start();
    const approval = approvalFor(run, project.id);
    await store.insert(approval);

    const response = await decide(base, approval.id, { approved: true });
    expect(response.status).toBe(200);
    const decided = (await response.json()) as ApprovalRequest;
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('local-user');
    expect(decided.decidedAt).toBeTruthy();
  });

  it('blocks the run when the action is rejected', async () => {
    const { base, store, run, project } = await start();
    const approval = approvalFor(run, project.id);
    await store.insert(approval);

    const decided = (await (
      await decide(base, approval.id, { approved: false, reason: 'not this file' })
    ).json()) as ApprovalRequest;
    expect(decided.status).toBe('rejected');
    expect(decided.reason).toBe('not this file');

    const blocked = await store.get<Run>(run.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.error).toBe('approval_rejected');
  });

  it('treats a missing approved flag as a rejection rather than an approval', async () => {
    // Failing closed matters more here than convenience: a malformed decision
    // must not be read as consent.
    const { base, store, run, project } = await start();
    const approval = approvalFor(run, project.id);
    await store.insert(approval);
    const decided = (await (await decide(base, approval.id, {})).json()) as ApprovalRequest;
    expect(decided.status).toBe('rejected');
  });

  it('refuses a request that has already been decided', async () => {
    const { base, store, run, project } = await start();
    const approval = approvalFor(run, project.id);
    await store.insert(approval);
    await decide(base, approval.id, { approved: true });

    const second = await decide(base, approval.id, { approved: true });
    expect(second.status).toBeGreaterThanOrEqual(400);
    await expect(second.json()).resolves.toMatchObject({
      message: 'approval_not_pending_or_expired',
    });
  });

  it('refuses an expired request', async () => {
    // An approval left unanswered must not still authorise the action later.
    const { base, store, run, project } = await start();
    const expired = approvalFor(run, project.id, {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.insert(expired);

    const response = await decide(base, expired.id, { approved: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await store.get<ApprovalRequest>(expired.id))?.status).toBe('pending');
  });

  it('refuses an approval whose scope does not match its run project', async () => {
    const { base, store, run } = await start();
    const mismatched = approvalFor(run, 'a-different-project');
    await store.insert(mismatched);
    const response = await decide(base, mismatched.id, { approved: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects an unknown approval id', async () => {
    const { base } = await start();
    const response = await decide(base, 'approval_missing', { approved: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('emergency stop', () => {
  it('stops every run that is still live and reports how many', async () => {
    const { base, store, run } = await start();
    const response = await fetch(`${base}/api/v1/stop-all`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stopped: number };
    expect(body.stopped).toBeGreaterThanOrEqual(1);
    expect((await store.get<Run>(run.id))?.status).toBe('cancelled');
  });

  it('leaves already-finished runs alone and reports zero', async () => {
    const { base, store, run } = await start();
    await store.put({
      ...run,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      version: run.version,
    } as Run);

    const body = (await (await fetch(`${base}/api/v1/stop-all`, { method: 'POST' })).json()) as {
      stopped: number;
    };
    expect(body.stopped).toBe(0);
    expect((await store.get<Run>(run.id))?.status).toBe('completed');
  });

  it('is safe to press twice', async () => {
    const { base } = await start();
    await fetch(`${base}/api/v1/stop-all`, { method: 'POST' });
    const second = await fetch(`${base}/api/v1/stop-all`, { method: 'POST' });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ stopped: 0 });
  });
});

describe('audit surface', () => {
  it('lists events and verifies the chain', async () => {
    const { base, store, run, project } = await start();
    await store.insert(approvalFor(run, project.id));

    const events = (await (await fetch(`${base}/api/v1/audit`)).json()) as unknown[];
    expect(Array.isArray(events)).toBe(true);
    await expect((await fetch(`${base}/api/v1/audit/verify`)).json()).resolves.toMatchObject({
      valid: true,
    });
  });

  it('still verifies after approvals and an emergency stop', async () => {
    const { base, store, run, project } = await start();
    const approval = approvalFor(run, project.id);
    await store.insert(approval);
    await decide(base, approval.id, { approved: false });
    await fetch(`${base}/api/v1/stop-all`, { method: 'POST' });
    await expect((await fetch(`${base}/api/v1/audit/verify`)).json()).resolves.toMatchObject({
      valid: true,
    });
  });
});
