import { CostRecord, ID, ISODate, UsageRecord } from './types.js';
import { BudgetWindow, budgetWindow } from './budgets.js';

export type CostGrouping = 'project' | 'agent' | 'model' | 'run';

export interface CostBucket {
  key: ID;
  grouping: CostGrouping;
  costCents: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  calls: number;
}

export interface CostReport {
  window: BudgetWindow;
  totalCostCents: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCalls: number;
  averageLatencyMs: number;
  buckets: CostBucket[];
}

const finite = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

const inWindow = (at: ISODate, window: BudgetWindow): boolean => {
  const value = Date.parse(at);
  if (!Number.isFinite(value)) return false;
  return value >= Date.parse(window.startsAt) && value < Date.parse(window.endsAt);
};

/**
 * Aggregate spend and token usage for a period. Usage records carry the token and latency
 * detail; cost records are authoritative for money, so a run that has a cost record does not
 * double-count its usage cost.
 */
export function costReport(
  usage: UsageRecord[],
  costs: CostRecord[],
  grouping: CostGrouping,
  options: { period?: BudgetWindow['period']; projectId?: ID; at?: Date } = {},
): CostReport {
  const window = budgetWindow(options.period ?? 'monthly', options.at ?? new Date());
  const scopedUsage = usage.filter(
    (record) =>
      inWindow(record.recordedAt, window) &&
      (!options.projectId || record.projectId === options.projectId),
  );
  const scopedCosts = costs.filter(
    (record) =>
      inWindow(record.createdAt, window) &&
      (!options.projectId || record.projectId === options.projectId),
  );
  const costedRuns = new Set(scopedCosts.map((record) => record.runId));
  const buckets = new Map<ID, CostBucket>();
  const bucketFor = (key: ID): CostBucket => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: CostBucket = {
      key,
      grouping,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      calls: 0,
    };
    buckets.set(key, created);
    return created;
  };
  const usageKey = (record: UsageRecord): ID =>
    grouping === 'project'
      ? record.projectId
      : grouping === 'agent'
        ? record.agentId
        : grouping === 'model'
          ? record.modelId
          : record.runId;
  for (const record of scopedUsage) {
    const bucket = bucketFor(usageKey(record));
    bucket.tokensIn += finite(record.tokensIn);
    bucket.tokensOut += finite(record.tokensOut);
    bucket.latencyMs += finite(record.latencyMs);
    bucket.calls += 1;
    if (!costedRuns.has(record.runId)) bucket.costCents += finite(record.costCents);
  }
  if (grouping !== 'model') {
    for (const record of scopedCosts) {
      const key =
        grouping === 'project'
          ? record.projectId
          : grouping === 'agent'
            ? record.agentId
            : record.runId;
      bucketFor(key).costCents += finite(record.amountCents);
    }
  } else {
    // Cost records are not model-scoped; attribute them through the run's usage records.
    const modelsByRun = new Map<ID, Set<ID>>();
    for (const record of scopedUsage) {
      const set = modelsByRun.get(record.runId) ?? new Set<ID>();
      set.add(record.modelId);
      modelsByRun.set(record.runId, set);
    }
    for (const record of scopedCosts) {
      const models = modelsByRun.get(record.runId);
      if (!models || models.size === 0) continue;
      const share = finite(record.amountCents) / models.size;
      for (const modelId of models) bucketFor(modelId).costCents += share;
    }
  }
  const ordered = [...buckets.values()].sort((a, b) => b.costCents - a.costCents);
  const totalCalls = ordered.reduce((sum, bucket) => sum + bucket.calls, 0);
  const totalLatency = ordered.reduce((sum, bucket) => sum + bucket.latencyMs, 0);
  return {
    window,
    totalCostCents: ordered.reduce((sum, bucket) => sum + bucket.costCents, 0),
    totalTokensIn: ordered.reduce((sum, bucket) => sum + bucket.tokensIn, 0),
    totalTokensOut: ordered.reduce((sum, bucket) => sum + bucket.tokensOut, 0),
    totalCalls,
    averageLatencyMs: totalCalls > 0 ? totalLatency / totalCalls : 0,
    buckets: ordered,
  };
}

/**
 * Project spend to the end of the current window using the elapsed-time run rate. Lifetime
 * budgets have no meaningful horizon, so they forecast to the observed spend.
 */
export function forecastCents(
  spentCents: number,
  window: BudgetWindow,
  at: Date = new Date(),
): number {
  if (window.period === 'lifetime') return finite(spentCents);
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  const elapsed = at.getTime() - start;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return finite(spentCents);
  const total = end - start;
  return finite(spentCents) * (total / Math.min(elapsed, total));
}
