import { describe, expect, it } from 'vitest';
import {
  budgetWindow,
  estimateCostCents,
  evaluateBudgets,
  normalizeBudget,
  spentCents,
} from '../src/budgets.js';
import { Budget, CostRecord, UsageRecord, entity } from '../src/types.js';

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({
    ...(entity({
      kind: 'budget',
      ownerId: 'user_1',
      scope: 'project_1',
    }) as Budget),
    projectId: 'project_1',
    name: 'Monthly cap',
    period: 'monthly',
    limitCents: 1000,
    warnRatio: 0.8,
    enabled: true,
    ...overrides,
  }) as Budget;

const makeCost = (amountCents: number, overrides: Partial<CostRecord> = {}): CostRecord =>
  ({
    ...(entity({ kind: 'cost', ownerId: 'user_1', scope: 'agent_1' }) as CostRecord),
    runId: `run_${Math.random()}`,
    projectId: 'project_1',
    agentId: 'agent_1',
    amountCents,
    currency: 'USD',
    category: 'model',
    ...overrides,
  }) as CostRecord;

const makeUsage = (costCents: number, overrides: Partial<UsageRecord> = {}): UsageRecord =>
  ({
    ...(entity({ kind: 'usage', ownerId: 'user_1', scope: 'agent_1' }) as UsageRecord),
    runId: `run_${Math.random()}`,
    projectId: 'project_1',
    agentId: 'agent_1',
    modelId: 'model_1',
    tokensIn: 100,
    tokensOut: 100,
    latencyMs: 10,
    costCents,
    recordedAt: new Date().toISOString(),
    ...overrides,
  }) as UsageRecord;

describe('budget windows', () => {
  it('bounds daily and monthly periods to UTC boundaries', () => {
    const at = new Date('2026-03-15T12:34:56.000Z');
    expect(budgetWindow('daily', at)).toMatchObject({
      startsAt: '2026-03-15T00:00:00.000Z',
      endsAt: '2026-03-16T00:00:00.000Z',
    });
    expect(budgetWindow('monthly', at)).toMatchObject({
      startsAt: '2026-03-01T00:00:00.000Z',
      endsAt: '2026-04-01T00:00:00.000Z',
    });
    expect(budgetWindow('lifetime', at).startsAt).toBe(new Date(0).toISOString());
  });
  it('excludes spend recorded outside the active window', () => {
    const budget = makeBudget({ period: 'daily' });
    const stale = makeCost(500, { createdAt: '2020-01-01T00:00:00.000Z' } as Partial<CostRecord>);
    const fresh = makeCost(250);
    expect(spentCents(budget, { usage: [], costs: [stale, fresh] })).toBe(250);
  });
});

describe('budget accounting', () => {
  it('counts usage only for runs without a cost record so in-flight steps still apply', () => {
    const budget = makeBudget();
    const cost = makeCost(100, { runId: 'run_a' });
    const settled = makeUsage(100, { runId: 'run_a' });
    const inFlight = makeUsage(40, { runId: 'run_b' });
    expect(spentCents(budget, { usage: [settled, inFlight], costs: [cost] })).toBe(140);
  });
  it('scopes agent budgets to their own agent spend', () => {
    const budget = makeBudget({ agentId: 'agent_1' });
    const mine = makeCost(120, { agentId: 'agent_1' });
    const other = makeCost(900, { agentId: 'agent_2' });
    expect(spentCents(budget, { usage: [], costs: [mine, other] })).toBe(120);
  });
  it('clamps hostile numeric fields instead of trusting stored values', () => {
    const normalized = normalizeBudget(
      makeBudget({ limitCents: Number.POSITIVE_INFINITY, warnRatio: 9 }),
    );
    expect(normalized.limitCents).toBe(0);
    expect(normalized.warnRatio).toBe(1);
  });
});

describe('budget enforcement', () => {
  it('warns at the soft threshold without blocking', () => {
    const budget = makeBudget({ limitCents: 1000, warnRatio: 0.8 });
    const decision = evaluateBudgets(
      [budget],
      { projectId: 'project_1', agentId: 'agent_1' },
      { usage: [], costs: [makeCost(850)] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings[0]!.state).toBe('warning');
  });
  it('blocks when projected spend reaches the hard limit', () => {
    const budget = makeBudget({ limitCents: 1000 });
    const decision = evaluateBudgets(
      [budget],
      { projectId: 'project_1', agentId: 'agent_1' },
      { usage: [], costs: [makeCost(900)] },
      150,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy?.state).toBe('exceeded');
    expect(decision.blockedBy?.remainingCents).toBe(0);
  });
  it('ignores disabled budgets and budgets for other projects or agents', () => {
    const decision = evaluateBudgets(
      [
        makeBudget({ limitCents: 1, enabled: false }),
        makeBudget({ limitCents: 1, projectId: 'project_2' }),
        makeBudget({ limitCents: 1, agentId: 'agent_9' }),
      ],
      { projectId: 'project_1', agentId: 'agent_1' },
      { usage: [], costs: [makeCost(500)] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.statuses).toHaveLength(0);
  });
  it('estimates cost from per-million token rates', () => {
    expect(
      estimateCostCents(
        { inputCostPerMillionCents: 200, outputCostPerMillionCents: 600 },
        1_000_000,
        500_000,
      ),
    ).toBe(500);
    expect(
      estimateCostCents(
        { inputCostPerMillionCents: Number.NaN, outputCostPerMillionCents: 100 },
        1_000_000,
        1_000_000,
      ),
    ).toBe(100);
  });
});
