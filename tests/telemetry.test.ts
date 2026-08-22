import { describe, expect, it } from 'vitest';
import { renderMetrics, runToOtlp } from '../src/telemetry.js';
import { Run, RunStep, entity } from '../src/types.js';

const run = (overrides: Partial<Run> = {}): Run =>
  entity({
    kind: 'run',
    ownerId: 'u',
    scope: 'p1',
    projectId: 'p1',
    environmentId: 'e1',
    agentId: 'a1',
    mode: 'execute',
    status: 'completed',
    stepCount: 2,
    maxSteps: 10,
    startedAt: '2026-08-21T10:00:00.000Z',
    finishedAt: '2026-08-21T10:00:05.000Z',
    tokensIn: 100,
    tokensOut: 20,
    costCents: 3,
    latencyMs: 5000,
    ...overrides,
  }) as Run;

const step = (runId: string, sequence: number, overrides: Partial<RunStep> = {}): RunStep =>
  entity({
    kind: 'run-step',
    ownerId: 'u',
    scope: runId,
    runId,
    sequence,
    type: 'model',
    status: 'succeeded',
    name: 'call',
    startedAt: '2026-08-21T10:00:01.000Z',
    finishedAt: '2026-08-21T10:00:02.000Z',
    durationMs: 1000,
    redacted: true,
    ...overrides,
  }) as RunStep;

describe('OpenTelemetry trace export', () => {
  it('produces a deterministic OTLP payload with a root span and child steps', () => {
    const subject = run();
    const steps = [step(subject.id, 2, { type: 'tool', name: 'fs.read' }), step(subject.id, 1)];
    const first = runToOtlp(subject, steps);
    const second = runToOtlp(subject, steps);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const spans = first.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(3);
    expect(spans[0]!.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(spans[0]!.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(spans[0]!.status.code).toBe('STATUS_CODE_OK');
    // Children are ordered by sequence and parented to the run span.
    expect(spans[1]!.name).toBe('model call');
    expect(spans[2]!.name).toBe('tool fs.read');
    expect(spans[1]!.parentSpanId).toBe(spans[0]!.spanId);
    expect(spans[2]!.kind).toBe('SPAN_KIND_CLIENT');
  });

  it('marks failed runs as errors and redacts the error message', () => {
    const key = ['sk', 'a1b2c3d4e5f6g7h8'].join('-');
    const failed = runToOtlp(run({ status: 'failed', error: `boom ${key}` }), []);
    const root = failed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(root.status.code).toBe('STATUS_CODE_ERROR');
    expect(root.status.message).toContain('[REDACTED]');
    expect(root.status.message).not.toContain(key);
  });

  it('ignores steps belonging to other runs and marks failures', () => {
    const subject = run();
    const spans = runToOtlp(subject, [
      step('other-run', 1),
      step(subject.id, 1, { status: 'failed' }),
    ]).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);
    expect(spans[1]!.status.code).toBe('STATUS_CODE_ERROR');
  });

  it('renders scrapeable metrics and drops non-finite values', () => {
    const text = renderMetrics([
      { name: 'bot_buffet_runs_active', value: 2, unit: 'runs' },
      { name: 'bot_buffet_broken', value: Number.NaN, unit: 'runs' },
    ]);
    expect(text).toContain('bot_buffet_runs_active 2');
    expect(text).toContain('# TYPE bot_buffet_runs_active gauge');
    expect(text).not.toContain('bot_buffet_broken');
  });
});
