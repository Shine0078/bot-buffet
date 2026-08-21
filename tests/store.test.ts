import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStateStore } from '../src/store.js';
import { entity } from '../src/types.js';

describe('durable state and tamper-evident audit', () => {
  it('survives a new store instance and verifies the audit chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const path = join(dir, 'state.json');
    const store = new JsonStateStore(path);
    const project = entity({
      kind: 'project',
      ownerId: 'u',
      scope: 'w',
      workspaceId: 'w',
      name: 'P',
      slug: 'p',
      archived: false,
    });
    await store.insert(project);
    await store.audit({
      kind: 'audit-event',
      ownerId: 'u',
      scope: 'p',
      actorId: 'u',
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      risk: 'low',
      decision: 'executed',
      metadata: {},
    });
    const reloaded = new JsonStateStore(path);
    expect((await reloaded.get<typeof project>(project.id))?.name).toBe('P');
    expect((await reloaded.verifyAuditChain()).valid).toBe(true);
    expect((await readFile(path, 'utf8')).length).toBeGreaterThan(0);
  });
  it('enforces resource locks between owners', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const store = new JsonStateStore(join(dir, 'state.json'));
    expect(await store.lock('file:a', 'a', 10000)).toBe(true);
    expect(await store.lock('file:a', 'b', 10000)).toBe(false);
    await store.unlock('file:a', 'a');
    expect(await store.lock('file:a', 'b', 10000)).toBe(true);
  });
  it('persists idempotency responses for replay after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const path = join(dir, 'state.json');
    const store = new JsonStateStore(path);
    await store.setIdempotency('u:/api/v1/runs:key', 202, { id: 'run_1' });
    const reloaded = new JsonStateStore(path);
    expect(await reloaded.getIdempotency('u:/api/v1/runs:key')).toMatchObject({
      status: 202,
      payload: { id: 'run_1' },
    });
  });
  it('claims an idempotency key only once under concurrent requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const store = new JsonStateStore(join(dir, 'state.json'));
    const claims = await Promise.all([
      store.claimIdempotency('u:/api/v1/runs:concurrent'),
      store.claimIdempotency('u:/api/v1/runs:concurrent'),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.claimed)).toHaveLength(1);
  });
});
