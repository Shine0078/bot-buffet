import type { Task } from './types.js';

/**
 * Task dependency gating.
 *
 * Tasks carry a `dependencyIds` list, and the API validates on creation that
 * each referenced task exists and belongs to the same project. Nothing checked
 * it again after that. A task declared to depend on another therefore ran the
 * moment someone started it, whether or not the thing it depends on had
 * finished -- so the dependency graph was documentation rather than a
 * constraint, and the guarantee it appears to offer ("this runs after that")
 * was never held.
 *
 * That matters most in exactly the case dependencies exist for: a fan-out where
 * several agents work in parallel and one task consumes another's output. It
 * would start against a workspace the producer had not written yet, and fail in
 * a way that looks like a model or tool problem rather than an ordering one.
 */

/** Terminal states. A dependency is satisfied only by completing successfully. */
const SATISFIED: ReadonlySet<Task['status']> = new Set(['done']);

/**
 * Statuses that can still become `done`. Anything else is a dead end, and
 * waiting on it means waiting forever -- worth distinguishing, because "not
 * ready yet" and "never going to be ready" call for different operator action.
 */
const REACHABLE: ReadonlySet<Task['status']> = new Set(['backlog', 'ready', 'running', 'blocked']);

export interface BlockingDependency {
  taskId: string;
  /** Absent when the dependency has been deleted since it was recorded. */
  status?: Task['status'];
  reason: 'incomplete' | 'unreachable' | 'missing' | 'cycle';
}

export interface DependencyVerdict {
  runnable: boolean;
  blockedBy: BlockingDependency[];
}

const describe = (blocker: BlockingDependency): string =>
  blocker.reason === 'missing'
    ? `${blocker.taskId} (deleted)`
    : blocker.reason === 'cycle'
      ? `${blocker.taskId} (cycle)`
      : `${blocker.taskId} (${blocker.status})`;

/**
 * Decide whether a task may run.
 *
 * Only direct dependencies are examined. Transitive ones are covered
 * inductively -- a dependency cannot itself be `done` unless its own
 * dependencies were satisfied when it ran -- and walking the whole graph on
 * every start would turn an unrelated deep failure into a confusing error
 * naming a task the operator never touched.
 *
 * A cycle is reported rather than tolerated: two tasks depending on each other
 * can never both reach `done`, so silently blocking both would strand the run
 * queue with no explanation. The task API cannot currently create one -- a new
 * task's id is not yet referenced by anything -- but the state file is JSON an
 * operator can edit, and entities reach the store through paths other than that
 * endpoint, so the check earns its place at evaluation time rather than being
 * pushed to creation where it would have nothing to guard.
 */
export function evaluateDependencies(
  task: Task,
  byId: ReadonlyMap<string, Task>,
): DependencyVerdict {
  const blockedBy: BlockingDependency[] = [];
  for (const dependencyId of task.dependencyIds ?? []) {
    if (dependencyId === task.id) {
      blockedBy.push({ taskId: dependencyId, reason: 'cycle' });
      continue;
    }
    const dependency = byId.get(dependencyId);
    if (!dependency) {
      // A dependency deleted after the fact leaves a claim that can never be
      // satisfied. Treating a dangling reference as satisfied would silently
      // drop the ordering guarantee at the exact moment it stopped being
      // checkable.
      blockedBy.push({ taskId: dependencyId, reason: 'missing' });
      continue;
    }
    if (SATISFIED.has(dependency.status)) continue;
    if (participatesInCycle(task.id, dependencyId, byId)) {
      blockedBy.push({ taskId: dependencyId, status: dependency.status, reason: 'cycle' });
      continue;
    }
    blockedBy.push({
      taskId: dependencyId,
      status: dependency.status,
      reason: REACHABLE.has(dependency.status) ? 'incomplete' : 'unreachable',
    });
  }
  return { runnable: blockedBy.length === 0, blockedBy };
}

/** Whether following `from`'s dependencies leads back to `origin`. */
function participatesInCycle(
  origin: string,
  from: string,
  byId: ReadonlyMap<string, Task>,
): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === origin) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const task = byId.get(current);
    for (const next of task?.dependencyIds ?? []) queue.push(next);
  }
  return false;
}

/**
 * The error a refused start raises.
 *
 * It names the blocking tasks and their states, because "blocked" on its own
 * gives an operator nothing to act on -- the useful question is always which
 * task to look at next.
 */
export function dependencyError(verdict: DependencyVerdict): Error {
  return new Error(`run_denied:dependencies_unmet:${verdict.blockedBy.map(describe).join(', ')}`);
}
