import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationService } from '../src/authorization.js';
import { createStore } from '../src/store.js';
import {
  entity,
  type BaseEntity,
  type Membership,
  type Project,
  type ProjectFile,
  type Workspace,
} from '../src/types.js';

/**
 * `accessPolicy` is stamped onto every entity and, until now, read by nothing.
 * Both halves of it were decorative: `visibility: 'private'` granted nothing,
 * and `roles` could not grant anything either.
 *
 * These tests pin both directions -- that private actually withholds access
 * from someone who would otherwise have it by role, and that a per-entity grant
 * actually confers it on someone who has no membership at all. A test that only
 * checked one direction would pass against a stub that always returned the same
 * answer.
 */

async function setup() {
  const store = createStore(await mkdtemp(join(tmpdir(), 'bot-buffet-access-')));
  const workspace = entity({
    kind: 'workspace',
    ownerId: 'alice',
    scope: 'org',
    organizationId: 'org',
    name: 'W',
    slug: 'w',
  }) as Workspace;
  const project = entity({
    kind: 'project',
    ownerId: 'alice',
    scope: workspace.id,
    workspaceId: workspace.id,
    name: 'P',
    slug: 'p',
    archived: false,
  }) as Project;
  await store.insert(workspace);
  await store.insert(project);
  // Bob is a developer in the workspace: read and write by role, no approve.
  await store.insert(
    entity({
      kind: 'membership',
      ownerId: 'alice',
      scope: workspace.id,
      userId: 'bob',
      workspaceId: workspace.id,
      role: 'developer',
    }) as Membership,
  );
  const file = (overrides: Partial<BaseEntity> = {}) => {
    const value = entity({
      kind: 'file',
      ownerId: 'alice',
      scope: project.id,
      projectId: project.id,
      path: 'notes.md',
      sha256: 'x'.repeat(64),
      size: 1,
      versionLabel: 'v1',
    }) as ProjectFile;
    return Object.assign(value, overrides) as ProjectFile;
  };
  return { store, workspace, project, file, auth: new AuthorizationService(store) };
}

describe('visibility is enforced, not decorative', () => {
  it('lets a workspace member read a normally-visible file', async () => {
    const { auth, file } = await setup();
    // The baseline. Without this, the private case below could pass for the
    // wrong reason -- because nothing is readable at all.
    expect(await auth.can('bob', file(), 'read')).toBe(true);
  });

  it('withholds a private file from a member who would otherwise have access', async () => {
    const { auth, file } = await setup();
    const priv = file({ accessPolicy: { visibility: 'private', roles: {} } });
    expect(await auth.can('bob', priv, 'read')).toBe(false);
    expect(await auth.can('bob', priv, 'write')).toBe(false);
  });

  it('still lets the owner reach their own private file', async () => {
    const { auth, file } = await setup();
    const priv = file({ accessPolicy: { visibility: 'private', roles: {} } });
    expect(await auth.can('alice', priv, 'write')).toBe(true);
  });

  it('treats an entity with no recorded policy as it behaved before enforcement', async () => {
    const { auth, file } = await setup();
    // Stored data predating this change has no accessPolicy. Enforcement must
    // not retroactively lock an operator out of their own state file.
    const legacy = file();
    delete (legacy as Partial<BaseEntity>).accessPolicy;
    expect(await auth.can('bob', legacy, 'read')).toBe(true);
  });
});

describe('per-entity role grants', () => {
  it('grants an action to someone with no membership at all', async () => {
    const { auth, file } = await setup();
    // Carol is in no workspace. Without the grant she has nothing.
    expect(await auth.can('carol', file(), 'read')).toBe(false);
    const shared = file({
      accessPolicy: { visibility: 'project', roles: { reviewer: ['carol'] } },
    });
    expect(await auth.can('carol', shared, 'read')).toBe(true);
    expect(await auth.can('carol', shared, 'approve')).toBe(true);
  });

  it('confers only the actions that role carries', async () => {
    const { auth, file } = await setup();
    const shared = file({ accessPolicy: { visibility: 'project', roles: { viewer: ['carol'] } } });
    expect(await auth.can('carol', shared, 'read')).toBe(true);
    expect(await auth.can('carol', shared, 'write')).toBe(false);
    expect(await auth.can('carol', shared, 'admin')).toBe(false);
  });

  it('reaches inside a private entity, which is the whole point', async () => {
    const { auth, file } = await setup();
    // "Private, except for this one reviewer" has to be expressible, or the
    // grant map can only ever subtract access.
    const shared = file({
      accessPolicy: { visibility: 'private', roles: { reviewer: ['carol'] } },
    });
    expect(await auth.can('carol', shared, 'approve')).toBe(true);
    expect(await auth.can('bob', shared, 'read')).toBe(false);
  });

  it('ignores an unknown role name rather than trusting it', async () => {
    const { auth, file } = await setup();
    // A typo must not become a grant, and stored JSON is not guaranteed to hold
    // a role this build knows about.
    const typo = file({
      accessPolicy: {
        visibility: 'project',
        roles: { revewer: ['carol'] } as unknown as Record<string, string[]>,
      },
    });
    expect(await auth.can('carol', typo, 'read')).toBe(false);
  });

  it('ignores a malformed grant list', async () => {
    const { auth, file } = await setup();
    const broken = file({
      accessPolicy: {
        visibility: 'project',
        roles: { reviewer: 'carol' as unknown as string[] },
      },
    });
    expect(await auth.can('carol', broken, 'read')).toBe(false);
  });

  it('does not grant to a different subject', async () => {
    const { auth, file } = await setup();
    const shared = file({ accessPolicy: { visibility: 'private', roles: { admin: ['carol'] } } });
    expect(await auth.can('dave', shared, 'read')).toBe(false);
  });
});

describe('filter respects the same rules', () => {
  it('drops private entities the actor cannot reach', async () => {
    const { auth, file } = await setup();
    const visible = file();
    const hidden = file({ accessPolicy: { visibility: 'private', roles: {} } });
    const granted = file({ accessPolicy: { visibility: 'private', roles: { viewer: ['bob'] } } });
    const kept = await auth.filter('bob', [visible, hidden, granted], 'read');
    expect(kept.map((value) => value.id)).toEqual([visible.id, granted.id]);
  });
});
