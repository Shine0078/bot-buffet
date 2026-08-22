import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  it('deletes only the expected entity version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-delete-cas-'));
    const store = new JsonStateStore(join(dir, 'state.json'));
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
    await expect(store.deleteIfVersion(project.id, project.version + 1)).rejects.toThrow(
      'concurrent_update',
    );
    await expect(store.get(project.id)).resolves.toBeDefined();
    await expect(store.deleteIfVersion(project.id, project.version)).resolves.toMatchObject({
      id: project.id,
    });
    await expect(store.get(project.id)).resolves.toBeUndefined();
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
  it('normalizes legacy state and rejects a future schema version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-schema-'));
    const path = join(dir, 'state.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 0, entities: {} }), { mode: 0o600 });
    const migrated = new JsonStateStore(path);
    await migrated.load();
    await expect(migrated.snapshot()).resolves.toMatchObject({
      schemaVersion: 1,
      runState: {},
      locks: {},
      idempotency: {},
      deletedScopes: {},
      auditTail: 'GENESIS',
    });
    const futurePath = join(dir, 'future.json');
    await writeFile(futurePath, JSON.stringify({ schemaVersion: 2 }), { mode: 0o600 });
    await expect(new JsonStateStore(futurePath).load()).rejects.toThrow('state_schema_newer');
    const malformedPath = join(dir, 'malformed.json');
    await writeFile(malformedPath, JSON.stringify({ schemaVersion: 1, entities: [] }), {
      mode: 0o600,
    });
    await expect(new JsonStateStore(malformedPath).load()).rejects.toThrow('state_schema_invalid');
  });
  it('tombstones a deleted project and rejects delayed child inserts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-project-delete-'));
    const store = new JsonStateStore(join(dir, 'state.json'));
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
    await expect(store.deleteProjectIfVersion(project.id, project.version)).resolves.toMatchObject({
      project: { id: project.id },
      deleted: expect.arrayContaining([expect.objectContaining({ id: project.id })]),
    });
    const child = entity({
      kind: 'environment',
      ownerId: 'u',
      scope: project.id,
      projectId: project.id,
      name: 'late',
      network: 'blocked' as const,
      persistent: false,
      protected: false,
    });
    await expect(store.insert(child)).rejects.toThrow('project_deleted');
    await expect(store.upsert(child)).rejects.toThrow('project_deleted');
  });
});
