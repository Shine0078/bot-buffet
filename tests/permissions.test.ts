import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationService } from '../src/authorization.js';
import { evaluatePermissions, hasPermission } from '../src/security.js';
import { createStore } from '../src/store.js';
import {
  entity,
  type Membership,
  type Permission,
  type Project,
  type ProjectFile,
  type Workspace,
} from '../src/types.js';

/**
 * The Permission entity was defined, exported, included in the entity union --
 * and evaluated by nothing. Its one reader, `hasPermission`, had no callers,
 * and ignored `conditions` outright: a permission written to apply only inside
 * one project applied everywhere, so the stored rule was strictly broader than
 * it read.
 */

const permission = (overrides: Partial<Permission>): Permission =>
  entity({
    kind: 'permission',
    ownerId: 'admin',
    scope: 'workspace-1',
    subjectId: 'carol',
    resource: '*',
    actions: ['*'],
    effect: 'allow',
    ...overrides,
  }) as Permission;

describe('conditions are honoured', () => {
  it('applies a permission whose conditions all match', () => {
    const p = permission({ conditions: { projectId: 'project-1' } });
    expect(hasPermission(p, 'read', 'file:1', { projectId: 'project-1' })).toBe(true);
  });

  it('withholds it where the condition does not hold', () => {
    // The defect: this returned true, because conditions were never read.
    const p = permission({ conditions: { projectId: 'project-1' } });
    expect(hasPermission(p, 'read', 'file:1', { projectId: 'project-2' })).toBe(false);
  });

  it('withholds it when the context does not mention the condition at all', () => {
    // An unevaluatable condition must narrow, never widen -- otherwise a caller
    // that forgets to pass context silently receives the unconditioned grant.
    const p = permission({ conditions: { projectId: 'project-1' } });
    expect(hasPermission(p, 'read', 'file:1')).toBe(false);
  });

  it('requires every condition, not merely one', () => {
    const p = permission({ conditions: { projectId: 'project-1', scope: 'workspace-1' } });
    expect(hasPermission(p, 'read', 'file:1', { projectId: 'project-1' })).toBe(false);
    expect(
      hasPermission(p, 'read', 'file:1', { projectId: 'project-1', scope: 'workspace-1' }),
    ).toBe(true);
  });
});

describe('resource and action matching', () => {
  it('covers a record through its kind', () => {
    expect(hasPermission(permission({ resource: 'run' }), 'read', 'run:abc')).toBe(true);
  });

  it('does not let a kind prefix leak into an unrelated name', () => {
    // `project` must not match `project-secrets`: a different resource that
    // merely starts with the same letters.
    expect(hasPermission(permission({ resource: 'project' }), 'read', 'project-secrets')).toBe(
      false,
    );
  });

  it('confines a record-scoped permission to that record', () => {
    const p = permission({ resource: 'run:abc' });
    expect(hasPermission(p, 'read', 'run:abc')).toBe(true);
    expect(hasPermission(p, 'read', 'run:def')).toBe(false);
  });

  it('respects the action list', () => {
    const p = permission({ actions: ['read'] });
    expect(hasPermission(p, 'read', 'run:abc')).toBe(true);
    expect(hasPermission(p, 'write', 'run:abc')).toBe(false);
  });

  it('does not apply to a different subject', () => {
    const decision = evaluatePermissions([permission({ subjectId: 'carol' })], {
      subjectId: 'dave',
      action: 'read',
      resource: 'run:abc',
    });
    expect(decision).toBe('unspecified');
  });
});

describe('deny wins', () => {
  it('overrides a broad allow', () => {
    const decision = evaluatePermissions(
      [
        permission({ resource: '*', actions: ['*'], effect: 'allow' }),
        permission({ resource: 'file:secret', actions: ['write'], effect: 'deny' }),
      ],
      { subjectId: 'carol', action: 'write', resource: 'file:secret' },
    );
    expect(decision).toBe('deny');
  });

  it('is not order-dependent', () => {
    const rules = [
      permission({ resource: 'file:secret', actions: ['write'], effect: 'deny' }),
      permission({ resource: '*', actions: ['*'], effect: 'allow' }),
    ];
    expect(
      evaluatePermissions(rules, { subjectId: 'carol', action: 'write', resource: 'file:secret' }),
    ).toBe('deny');
  });

  it('reports silence as unspecified rather than denial', () => {
    // A caller has to be able to tell a deliberate refusal from no opinion, or
    // it cannot apply its own default.
    expect(evaluatePermissions([], { subjectId: 'carol', action: 'read', resource: 'x' })).toBe(
      'unspecified',
    );
  });
});

describe('the authorization service enforces them', () => {
  async function setup() {
    const store = createStore(await mkdtemp(join(tmpdir(), 'bot-buffet-perm-')));
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
    const file = entity({
      kind: 'file',
      ownerId: 'alice',
      scope: project.id,
      projectId: project.id,
      path: 'notes.md',
      sha256: 'x'.repeat(64),
      size: 1,
      versionLabel: 'v1',
    }) as ProjectFile;
    return { store, project, file, auth: new AuthorizationService(store) };
  }

  it('leaves behaviour unchanged when no permissions are installed', async () => {
    const { auth, file } = await setup();
    expect(await auth.can('bob', file, 'write')).toBe(true);
    expect(await auth.can('carol', file, 'read')).toBe(false);
  });

  it('lets a deny carve an exception out of a role grant', async () => {
    const { auth, file, store } = await setup();
    await store.insert(
      permission({ subjectId: 'bob', resource: 'file', actions: ['write'], effect: 'deny' }),
    );
    expect(await auth.can('bob', file, 'write')).toBe(false);
    // And only that action: the rest of the role survives.
    expect(await auth.can('bob', file, 'read')).toBe(true);
  });

  it('lets a deny bind the owner, who is otherwise unstoppable', async () => {
    const { auth, file, store } = await setup();
    // Without this, "deny write on production" is unenforceable against the
    // person most able to cause damage.
    await store.insert(
      permission({ subjectId: 'alice', resource: 'file', actions: ['write'], effect: 'deny' }),
    );
    expect(await auth.can('alice', file, 'write')).toBe(false);
  });

  it('grants access to someone with no membership', async () => {
    const { auth, file, store } = await setup();
    await store.insert(permission({ subjectId: 'carol', resource: 'file', actions: ['read'] }));
    expect(await auth.can('carol', file, 'read')).toBe(true);
    expect(await auth.can('carol', file, 'write')).toBe(false);
  });

  it('scopes a grant by condition', async () => {
    const { auth, file, store, project } = await setup();
    await store.insert(
      permission({
        subjectId: 'carol',
        resource: 'file',
        actions: ['read'],
        conditions: { projectId: project.id },
      }),
    );
    expect(await auth.can('carol', file, 'read')).toBe(true);

    const elsewhere = entity({
      kind: 'file',
      ownerId: 'alice',
      scope: 'other-project',
      projectId: 'other-project',
      path: 'other.md',
      sha256: 'y'.repeat(64),
      size: 1,
      versionLabel: 'v1',
    }) as ProjectFile;
    expect(await auth.can('carol', elsewhere, 'read')).toBe(false);
  });

  it('targets a single record when the resource names one', async () => {
    const { auth, file, store } = await setup();
    await store.insert(
      permission({ subjectId: 'carol', resource: `file:${file.id}`, actions: ['read'] }),
    );
    expect(await auth.can('carol', file, 'read')).toBe(true);
  });
});
