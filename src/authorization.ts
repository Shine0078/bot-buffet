import { AccessPolicy, BaseEntity, Entity, Membership, Project, RoleName } from './types.js';
import { JsonStateStore } from './store.js';

export type Action = 'read' | 'write' | 'run' | 'approve' | 'admin';

const roleAllows: Record<RoleName, Action[]> = {
  owner: ['read', 'write', 'run', 'approve', 'admin'],
  admin: ['read', 'write', 'run', 'approve', 'admin'],
  operator: ['read', 'run', 'approve'],
  reviewer: ['read', 'approve'],
  developer: ['read', 'write', 'run'],
  viewer: ['read'],
};

const isRoleName = (name: string): name is RoleName =>
  Object.prototype.hasOwnProperty.call(roleAllows, name);

/**
 * Entities whose `accessPolicy` predates enforcement have no policy recorded.
 * They are treated as workspace-visible with no per-entity grants, which is
 * exactly how they behaved before this file read the field at all — enforcement
 * must not retroactively lock an operator out of their own stored data.
 */
const effectivePolicy = (value: BaseEntity): AccessPolicy =>
  value.accessPolicy ?? { visibility: 'organization', roles: {} };

/**
 * Scope-aware authorization used by HTTP handlers. Production identity
 * validation remains an edge concern, but once an actor is established every
 * resource is filtered here.
 *
 * `accessPolicy` is attached to every entity by `entity()` and was previously
 * written by three call sites and read by none, so both halves of it were
 * decorative:
 *
 *   - `visibility: 'private'` granted nothing. A private run was still readable
 *     by every workspace member holding a role that allowed the action, because
 *     the membership check never looked at the label. Marking something private
 *     was a no-op that read like a control.
 *   - `roles` could not grant anything either. There was no way to give one
 *     reviewer approval rights on a single run without making them a reviewer
 *     across the entire workspace.
 *
 * Both are enforced below. The default stays `organization`, so entities
 * created before this change keep the access they already had; the tightening
 * applies only where someone explicitly asked for it.
 */
export class AuthorizationService {
  constructor(private readonly store: JsonStateStore) {}

  async can(actorId: string, value: BaseEntity, action: Action): Promise<boolean> {
    if (value.ownerId === actorId) return true;

    const policy = effectivePolicy(value);

    // An explicit grant on this entity is checked before anything can refuse,
    // including the private short-circuit below. That ordering is the point of
    // per-entity grants: "private, except for this reviewer" has to be
    // expressible, or the feature only ever subtracts access.
    if (this.grantedOnEntity(actorId, policy, action)) return true;

    // Private means owner-or-explicit-grant. Workspace membership, whatever the
    // role, is not enough -- otherwise the label means nothing.
    if (policy.visibility === 'private') return false;

    if (value.scope === 'system' && action === 'read') return true;

    const memberships = await this.store.list<Membership>(
      (item) => item.kind === 'membership' && (item as Membership).userId === actorId,
    );
    if (!memberships.length) return false;
    const workspaceId = await this.workspaceFor(value);
    if (!workspaceId) return false;
    return memberships.some(
      (membership) =>
        membership.workspaceId === workspaceId && roleAllows[membership.role].includes(action),
    );
  }

  /**
   * A per-entity role grant: `roles: { reviewer: ['user-1'] }` gives user-1 the
   * reviewer actions on this entity alone.
   *
   * Unknown role names are ignored rather than trusted. A typo like `revewer`
   * must not silently become a grant, and a role name arriving from stored JSON
   * is not guaranteed to be one this build knows about.
   */
  private grantedOnEntity(actorId: string, policy: AccessPolicy, action: Action): boolean {
    for (const [name, subjects] of Object.entries(policy.roles ?? {})) {
      if (!Array.isArray(subjects) || !subjects.includes(actorId)) continue;
      if (!isRoleName(name)) continue;
      if (roleAllows[name].includes(action)) return true;
    }
    return false;
  }

  async require(
    actorId: string,
    value: BaseEntity | undefined,
    action: Action,
  ): Promise<BaseEntity> {
    if (!value || !(await this.can(actorId, value, action)))
      throw new Error('forbidden_or_not_found');
    return value;
  }

  async filter<T extends BaseEntity>(actorId: string, values: T[], action: Action): Promise<T[]> {
    const decisions = await Promise.all(values.map((value) => this.can(actorId, value, action)));
    return values.filter((_value, index) => decisions[index]);
  }

  private async workspaceFor(value: BaseEntity): Promise<string | undefined> {
    const candidate = value as Entity & { projectId?: string; workspaceId?: string };
    if (candidate.workspaceId) return candidate.workspaceId;
    if (candidate.projectId)
      return (await this.store.get<Project>(candidate.projectId))?.workspaceId;
    const project = await this.store.get<Project>(value.scope);
    if (project) return project.workspaceId;
    const workspace = await this.store.get(value.scope);
    return (workspace as (BaseEntity & { kind?: string }) | undefined)?.kind === 'workspace'
      ? workspace!.id
      : undefined;
  }
}
