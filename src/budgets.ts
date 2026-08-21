import { Budget, BudgetPeriod, CostRecord, ID, ISODate, UsageRecord } from './types.js';

export interface BudgetWindow {
  period: BudgetPeriod;
  startsAt: ISODate;
  endsAt: ISODate;
}

export interface BudgetStatus {
  budgetId: ID;
  name: string;
  period: BudgetPeriod;
  limitCents: number;
  spentCents: number;
  projectedCents: number;
  remainingCents: number;
  warnAtCents: number;
  state: 'ok' | 'warning' | 'exceeded';
  window: BudgetWindow;
}

export interface BudgetDecision {
  allowed: boolean;
  /** Set when a hard limit blocks the call. */
  blockedBy?: BudgetStatus;
  /** Soft warnings that should surface to operators without blocking work. */
  warnings: BudgetStatus[];
  statuses: BudgetStatus[];
}

const MAX_LIMIT_CENTS = 1_000_000_000;

/** Resolve the inclusive-start/exclusive-end UTC window a budget period covers at `at`. */
export function budgetWindow(period: BudgetPeriod, at: Date = new Date()): BudgetWindow {
  if (period === 'lifetime')
    return {
      period,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(Date.UTC(9999, 0, 1)).toISOString(),
    };
  if (period === 'daily') {
    const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    return {
      period,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return { period, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

const inWindow = (recordedAt: string, window: BudgetWindow): boolean => {
  const value = Date.parse(recordedAt);
  if (!Number.isFinite(value)) return false;
  return value >= Date.parse(window.startsAt) && value < Date.parse(window.endsAt);
};

/** Normalize a persisted budget, clamping hostile or corrupt numeric fields. */
export function normalizeBudget(budget: Budget): Budget {
  const limitCents = Number.isFinite(budget.limitCents)
    ? Math.min(Math.max(0, budget.limitCents), MAX_LIMIT_CENTS)
    : 0;
  const warnRatio = Number.isFinite(budget.warnRatio)
    ? Math.min(Math.max(0, budget.warnRatio), 1)
    : 0.8;
  return { ...budget, limitCents, warnRatio };
}

export interface SpendSources {
  usage: UsageRecord[];
  costs: CostRecord[];
}

/**
 * Sum spend attributable to a budget inside its current window. Cost records are the
 * authoritative ledger; usage records are only counted for runs that produced no cost
 * record yet, so in-flight steps still apply pressure against the limit.
 */
export function spentCents(budget: Budget, sources: SpendSources, at: Date = new Date()): number {
  const window = budgetWindow(budget.period, at);
  const costedRunIds = new Set<ID>();
  let total = 0;
  for (const cost of sources.costs) {
    if (cost.projectId !== budget.projectId) continue;
    if (!inWindow(cost.createdAt, window)) continue;
    if (budget.agentId && cost.agentId !== budget.agentId) continue;
    costedRunIds.add(cost.runId);
    if (Number.isFinite(cost.amountCents)) total += Math.max(0, cost.amountCents);
  }
  for (const usage of sources.usage) {
    if (costedRunIds.has(usage.runId)) continue;
    if (usage.projectId !== budget.projectId) continue;
    if (budget.agentId && usage.agentId !== budget.agentId) continue;
    if (!inWindow(usage.recordedAt, window)) continue;
    if (Number.isFinite(usage.costCents)) total += Math.max(0, usage.costCents);
  }
  return total;
}

export function budgetStatus(
  budget: Budget,
  sources: SpendSources,
  additionalCents = 0,
  at: Date = new Date(),
): BudgetStatus {
  const normalized = normalizeBudget(budget);
  const spent = spentCents(normalized, sources, at);
  const pending = Number.isFinite(additionalCents) ? Math.max(0, additionalCents) : 0;
  const projected = spent + pending;
  const warnAtCents = normalized.limitCents * normalized.warnRatio;
  const state: BudgetStatus['state'] =
    normalized.limitCents > 0 && projected >= normalized.limitCents
      ? 'exceeded'
      : normalized.limitCents > 0 && projected >= warnAtCents
        ? 'warning'
        : 'ok';
  return {
    budgetId: normalized.id,
    name: normalized.name,
    period: normalized.period,
    limitCents: normalized.limitCents,
    spentCents: spent,
    projectedCents: projected,
    remainingCents: Math.max(0, normalized.limitCents - projected),
    warnAtCents,
    state,
    window: budgetWindow(normalized.period, at),
  };
}

/**
 * Decide whether a model call costing `additionalCents` may proceed. Budgets scoped to a
 * specific agent only apply to that agent; project budgets apply to every agent in scope.
 */
export function evaluateBudgets(
  budgets: Budget[],
  context: { projectId: ID; agentId?: ID },
  sources: SpendSources,
  additionalCents = 0,
  at: Date = new Date(),
): BudgetDecision {
  const applicable = budgets.filter(
    (budget) =>
      budget.enabled &&
      budget.projectId === context.projectId &&
      (!budget.agentId || budget.agentId === context.agentId),
  );
  const statuses = applicable.map((budget) => budgetStatus(budget, sources, additionalCents, at));
  const blockedBy = statuses.find((status) => status.state === 'exceeded');
  return {
    allowed: !blockedBy,
    blockedBy,
    warnings: statuses.filter((status) => status.state === 'warning'),
    statuses,
  };
}

/** Estimate the cents a model call will cost before it executes. */
export function estimateCostCents(
  model: { inputCostPerMillionCents: number; outputCostPerMillionCents: number },
  inputTokens: number,
  outputTokens: number,
): number {
  const input = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const output = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  const inputRate = Number.isFinite(model.inputCostPerMillionCents)
    ? Math.max(0, model.inputCostPerMillionCents)
    : 0;
  const outputRate = Number.isFinite(model.outputCostPerMillionCents)
    ? Math.max(0, model.outputCostPerMillionCents)
    : 0;
  return (input * inputRate + output * outputRate) / 1_000_000;
}
