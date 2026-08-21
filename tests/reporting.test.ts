import { describe, expect, it } from 'vitest';
import { costReport, forecastCents } from '../src/reporting.js';
import { budgetWindow } from '../src/budgets.js';
import { CostRecord, UsageRecord, entity } from '../src/types.js';

const usage = (
  runId: string,
  projectId: string,
  agentId: string,
  modelId: string,
  costCents: number,
  recordedAt: string,
): UsageRecord =>
  entity({
    kind: 'usage',
    ownerId: 'u',
    scope: agentId,
    runId,
    projectId,
    agentId,
    modelId,
    tokensIn: 100,
    tokensOut: 50,
    latencyMs: 200,
    costCents,
    recordedAt,
  }) as UsageRecord;

const cost = (runId: string, projectId: string, agentId: string, amountCents: number): CostRecord =>
  entity({
    kind: 'cost',
    ownerId: 'u',
    scope: agentId,
    runId,
    projectId,
    agentId,
    amountCents,
    currency: 'USD',
    category: 'model',
  }) as CostRecord;

describe('cost reporting', () => {
  const at = new Date('2026-08-15T12:00:00.000Z');
  const stamp = '2026-08-15T10:00:00.000Z';

  it('groups spend by project, agent, model, and run without double counting', () => {
    const usageRecords = [
      usage('run-1', 'p1', 'a1', 'm1', 40, stamp),
      usage('run-2', 'p1', 'a2', 'm2', 25, stamp),
      usage('run-3', 'p2', 'a3', 'm1', 10, stamp),
    ];
    // run-1 has an authoritative cost record, so its usage cost must not be added again.
    const costRecords = [cost('run-1', 'p1', 'a1', 60)];
    const byProject = costReport(usageRecords, costRecords, 'project', { at });
    expect(byProject.totalCostCents).toBe(95);
    expect(byProject.buckets[0]).toMatchObject({ key: 'p1', costCents: 85, calls: 2 });
    expect(byProject.totalTokensIn).toBe(300);

    const byAgent = costReport(usageRecords, costRecords, 'agent', { at });
    expect(byAgent.buckets.find((bucket) => bucket.key === 'a1')?.costCents).toBe(60);
    expect(byAgent.buckets.find((bucket) => bucket.key === 'a2')?.costCents).toBe(25);

    const byModel = costReport(usageRecords, costRecords, 'model', { at });
    expect(byModel.buckets.find((bucket) => bucket.key === 'm1')?.costCents).toBe(70);

    const byRun = costReport(usageRecords, costRecords, 'run', { at });
    expect(byRun.buckets.find((bucket) => bucket.key === 'run-1')?.costCents).toBe(60);
  });

  it('filters by project scope and window', () => {
    const records = [
      usage('run-1', 'p1', 'a1', 'm1', 40, stamp),
      usage('run-old', 'p1', 'a1', 'm1', 999, '2026-06-01T00:00:00.000Z'),
    ];
    const scoped = costReport(records, [], 'project', { at, projectId: 'p1', period: 'monthly' });
    expect(scoped.totalCostCents).toBe(40);
    expect(scoped.totalCalls).toBe(1);
    const other = costReport(records, [], 'project', { at, projectId: 'p2' });
    expect(other.totalCostCents).toBe(0);
  });

  it('ignores malformed numbers and timestamps', () => {
    const broken = usage('run-x', 'p1', 'a1', 'm1', Number.NaN, 'not-a-date');
    const valid = usage('run-y', 'p1', 'a1', 'm1', Number.POSITIVE_INFINITY, stamp);
    const report = costReport([broken, valid], [], 'project', { at });
    expect(report.totalCostCents).toBe(0);
    expect(report.totalCalls).toBe(1);
  });

  it('forecasts monthly spend from the elapsed run rate and never shrinks lifetime spend', () => {
    const monthly = budgetWindow('monthly', at);
    const forecast = forecastCents(100, monthly, at);
    expect(forecast).toBeGreaterThan(100);
    expect(forecastCents(100, budgetWindow('lifetime', at), at)).toBe(100);
    const daily = budgetWindow('daily', at);
    expect(forecastCents(50, daily, at)).toBeCloseTo(100, 5);
  });
});
