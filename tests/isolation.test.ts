import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationService } from '../src/authorization.js';
import { createStore } from '../src/store.js';
import { Membership, Project, ProjectFile, Workspace, entity } from '../src/types.js';

const setup = async () => {
  const store = createStore(await mkdtemp(join(tmpdir(), 'bot-buffet-isolation-')));
  const workspaceA = entity({
    kind: 'workspace',
    ownerId: 'alice',
    scope: 'org',
    organizationId: 'org',
    name: 'A',
    slug: 'a',
  }) as Workspace;
  const workspaceB = entity({
    kind: 'workspace',
    ownerId: 'bob',
    scope: 'org',
    organizationId: 'org',
    name: 'B',
    slug: 'b',
  }) as Workspace;
  await store.insert(workspaceA);
  await store.insert(workspaceB);
  const projectA = entity({
    kind: 'project',
    ownerId: 'alice',
    scope: workspaceA.id,
    workspaceId: workspaceA.id,
    name: 'A project',
    slug: 'a-project',
    archived: false,
  }) as Project;
  const projectB = entity({
    kind: 'project',
    ownerId: 'bob',
    scope: workspaceB.id,
    workspaceId: workspaceB.id,
    name: 'B project',
    slug: 'b-project',
    archived: false,
  }) as Project;
  await store.insert(projectA);
  await store.insert(projectB);
  await store.insert(
    entity({
      kind: 'membership',
      ownerId: 'alice',
      scope: workspaceA.id,
      userId: 'alice',
      workspaceId: workspaceA.id,
      role: 'owner',
    }) as Membership,
  );
  await store.insert(
    entity({
      kind: 'membership',
      ownerId: 'bob',
      scope: workspaceB.id,
      userId: 'bob',
      workspaceId: workspaceB.id,
      role: 'owner',
    }) as Membership,
  );
  return { store, projectA, projectB, workspaceA, workspaceB };
};

const file = (projectId: string, owner: string, path: string): ProjectFile =>
  entity({
    kind: 'file',
    ownerId: owner,
    scope: projectId,
    projectId,
    path,
    size: 10,
    sha256: 'x'.repeat(64),
    versionLabel: 'v1',
    locked: false,
  }) as ProjectFile;

describe('tenant and project isolation', () => {
  it('denies cross-workspace reads and writes', async () => {
    const { store, projectA, projectB } = await setup();
    const authorization = new AuthorizationService(store);
    expect(await authorization.can('alice', projectA, 'read')).toBe(true);
    expect(await authorization.can('alice', projectB, 'read')).toBe(false);
    expect(await authorization.can('bob', projectA, 'write')).toBe(false);
    await expect(authorization.require('bob', projectA, 'read')).rejects.toThrow(
      'forbidden_or_not_found',
    );
  });

  it('filters project-scoped records so one tenant never sees another tenant data', async () => {
    const { store, projectA, projectB } = await setup();
    const authorization = new AuthorizationService(store);
    const files = [
      file(projectA.id, 'alice', 'a/secret.md'),
      file(projectB.id, 'bob', 'b/secret.md'),
    ];
    for (const item of files) await store.insert(item);
    const visibleToAlice = await authorization.filter('alice', files, 'read');
    expect(visibleToAlice.map((item) => item.path)).toEqual(['a/secret.md']);
    const visibleToBob = await authorization.filter('bob', files, 'read');
    expect(visibleToBob.map((item) => item.path)).toEqual(['b/secret.md']);
  });

  it('denies an actor with no membership entirely', async () => {
    const { store, projectA } = await setup();
    const authorization = new AuthorizationService(store);
    expect(await authorization.can('mallory', projectA, 'read')).toBe(false);
    expect(await authorization.filter('mallory', [projectA], 'read')).toEqual([]);
  });

  it('enforces role actions rather than granting blanket workspace access', async () => {
    const { store, projectA, workspaceA } = await setup();
    await store.insert(
      entity({
        kind: 'membership',
        ownerId: 'viewer-user',
        scope: workspaceA.id,
        userId: 'viewer-user',
        workspaceId: workspaceA.id,
        role: 'viewer',
      }) as Membership,
    );
    const authorization = new AuthorizationService(store);
    expect(await authorization.can('viewer-user', projectA, 'read')).toBe(true);
    expect(await authorization.can('viewer-user', projectA, 'write')).toBe(false);
    expect(await authorization.can('viewer-user', projectA, 'admin')).toBe(false);
  });
});
