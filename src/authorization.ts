import { BaseEntity, Entity, Membership, Project, RoleName } from './types.js';
import { JsonStateStore } from './store.js';

type Action = 'read' | 'write' | 'run' | 'approve' | 'admin';
const roleAllows: Record<RoleName, Action[]> = {
  owner: ['read', 'write', 'run', 'approve', 'admin'],
  admin: ['read', 'write', 'run', 'approve', 'admin'],
  operator: ['read', 'run', 'approve'],
  reviewer: ['read', 'approve'],
  developer: ['read', 'write', 'run'],
  viewer: ['read'],
};

/** Scope-aware authorization used by HTTP handlers. Production identity validation remains an edge concern, but once an actor is established every resource is filtered here. */
export class AuthorizationService {
  constructor(private readonly store: JsonStateStore) {}

  async can(actorId: string, value: BaseEntity, action: Action): Promise<boolean> {
    if (value.ownerId === actorId) return true;
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
