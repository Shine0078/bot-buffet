import type { MemoryItem, MemoryPolicy } from './types.js';

/**
 * Agent-facing memory scoping.
 *
 * `memoryPolicy` declared `readableScopes`, `writableScopes`, `requireApproval`
 * and `retentionDays` on every agent profile, and nothing read any of it. That
 * mattered more than it looks, because the orchestrator never loaded memory
 * into agent context at all — so the policy governed a path that did not
 * exist, and the agent loop was missing the "load relevant memory" step the
 * design calls for.
 *
 * This module is the filter that sits between the two. It answers one
 * question: of everything stored, what may *this* agent see on *this* run?
 *
 * The rule that carries the isolation property is the namespace-identity
 * match. Being permitted to read the `project` namespace does not mean reading
 * every project's memory — it means reading *this run's* project. Without that
 * pairing, a readable scope would be a cross-tenant read.
 */

export interface MemoryScopeContext {
  ownerId: string;
  workspaceId?: string;
  projectId: string;
  environmentId?: string;
  agentId: string;
  taskId?: string;
  /** Session memory is bound to the run that produced it. */
  runId?: string;
}

/** The identity a namespace must match for this run. */
function expectedNamespaceId(
  namespace: MemoryItem['namespace'],
  scope: MemoryScopeContext,
): string | undefined {
  switch (namespace) {
    case 'user':
      return scope.ownerId;
    case 'workspace':
      return scope.workspaceId;
    case 'project':
      return scope.projectId;
    case 'environment':
      return scope.environmentId;
    case 'agent':
      return scope.agentId;
    case 'task':
      return scope.taskId;
    case 'session':
      return scope.runId;
    // `organization` and `artifact` are not derivable from a run context, so
    // they are never matched here. Returning undefined excludes them rather
    // than letting them through unmatched.
    default:
      return undefined;
  }
}

export type MemoryExclusion =
  | 'namespace_not_readable'
  | 'namespace_identity_mismatch'
  | 'not_approved'
  | 'expired'
  | 'beyond_retention';

export interface MemorySelection {
  readable: MemoryItem[];
  excluded: Array<{ id: string; reason: MemoryExclusion }>;
}

/**
 * Select the memory an agent may read, and record why anything was excluded.
 *
 * Exclusions are returned rather than silently dropped so a run that behaved
 * as if it had forgotten something can be explained from its own record.
 */
export function selectReadableMemory(
  items: MemoryItem[],
  policy: MemoryPolicy,
  scope: MemoryScopeContext,
  nowMs: number = Date.now(),
): MemorySelection {
  const readable: MemoryItem[] = [];
  const excluded: MemorySelection['excluded'] = [];
  const allowed = new Set(policy.readableScopes);

  for (const item of items) {
    if (!allowed.has(item.namespace)) {
      excluded.push({ id: item.id, reason: 'namespace_not_readable' });
      continue;
    }
    // The isolation rule: the right namespace is not enough, it must be this
    // run's instance of that namespace.
    const expected = expectedNamespaceId(item.namespace, scope);
    if (!expected || item.namespaceId !== expected) {
      excluded.push({ id: item.id, reason: 'namespace_identity_mismatch' });
      continue;
    }
    if (policy.requireApproval && !item.approved) {
      excluded.push({ id: item.id, reason: 'not_approved' });
      continue;
    }
    if (item.expiresAt && Date.parse(item.expiresAt) <= nowMs) {
      excluded.push({ id: item.id, reason: 'expired' });
      continue;
    }
    if (policy.retentionDays > 0) {
      const age = nowMs - Date.parse(item.freshnessAt ?? item.createdAt);
      if (Number.isFinite(age) && age > policy.retentionDays * 24 * 60 * 60 * 1000) {
        excluded.push({ id: item.id, reason: 'beyond_retention' });
        continue;
      }
    }
    readable.push(item);
  }

  return { readable, excluded };
}

/**
 * Whether an agent may write to a namespace.
 *
 * Separate from readability on purpose: an agent that may read project memory
 * is not thereby entitled to change it, and the common configuration is a
 * broad read scope with a narrow write scope.
 */
export function canWriteMemory(policy: MemoryPolicy, namespace: MemoryItem['namespace']): boolean {
  return policy.writableScopes.includes(namespace);
}
