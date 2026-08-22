import { createHash } from 'node:crypto';
import { Run, RunStep } from './types.js';
import { redactSecrets } from './security.js';

/**
 * OpenTelemetry-compatible trace export built from durable run state. Bot Buffet does not ship
 * a vendor SDK; it emits the OTLP/JSON span shape so any collector can ingest it, and so traces
 * survive process restarts because they are derived from persisted steps rather than memory.
 */
export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'SPAN_KIND_INTERNAL' | 'SPAN_KIND_CLIENT';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  status: { code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' | 'STATUS_CODE_UNSET'; message?: string };
}

export interface OtelTraceExport {
  resourceSpans: Array<{
    resource: { attributes: OtelSpan['attributes'] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtelSpan[] }>;
  }>;
}

/** Deterministic hex id so replayed exports of the same run produce identical trace ids. */
const hexId = (value: string, bytes: 8 | 16): string =>
  createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, bytes * 2);

const unixNano = (iso?: string): string => {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return String((Number.isFinite(parsed) ? parsed : 0) * 1_000_000);
};

const attr = (key: string, value: unknown): OtelSpan['attributes'][number] =>
  typeof value === 'number' && Number.isFinite(value)
    ? { key, value: { intValue: String(Math.trunc(value)) } }
    : { key, value: { stringValue: String(redactSecrets(value ?? '')) } };

const STEP_STATUS: Record<RunStep['status'], OtelSpan['status']['code']> = {
  started: 'STATUS_CODE_UNSET',
  succeeded: 'STATUS_CODE_OK',
  failed: 'STATUS_CODE_ERROR',
  skipped: 'STATUS_CODE_UNSET',
};

/** Convert a run and its steps into an OTLP/JSON trace payload. */
export function runToOtlp(run: Run, steps: RunStep[], serviceVersion = '0.1.0'): OtelTraceExport {
  const traceId = hexId(run.id, 16);
  const rootSpanId = hexId(`${run.id}:root`, 8);
  const root: OtelSpan = {
    traceId,
    spanId: rootSpanId,
    name: `run ${run.mode}`,
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: unixNano(run.startedAt ?? run.createdAt),
    endTimeUnixNano: unixNano(run.finishedAt ?? run.updatedAt),
    attributes: [
      attr('bot_buffet.run.id', run.id),
      attr('bot_buffet.project.id', run.projectId),
      attr('bot_buffet.agent.id', run.agentId),
      attr('bot_buffet.run.status', run.status),
      attr('bot_buffet.run.steps', run.stepCount),
      attr('bot_buffet.tokens.in', run.tokensIn),
      attr('bot_buffet.tokens.out', run.tokensOut),
      attr('bot_buffet.cost.cents', run.costCents),
    ],
    status: {
      code:
        run.status === 'completed'
          ? 'STATUS_CODE_OK'
          : ['failed', 'blocked', 'cancelled'].includes(run.status)
            ? 'STATUS_CODE_ERROR'
            : 'STATUS_CODE_UNSET',
      ...(run.error ? { message: String(redactSecrets(run.error)).slice(0, 200) } : {}),
    },
  };
  const spans = [...steps]
    .filter((step) => step.runId === run.id)
    .sort((a, b) => a.sequence - b.sequence)
    .map<OtelSpan>((step) => ({
      traceId,
      spanId: hexId(`${run.id}:${step.id}`, 8),
      parentSpanId: rootSpanId,
      name: `${step.type} ${step.name}`,
      kind:
        step.type === 'model' || step.type === 'tool' ? 'SPAN_KIND_CLIENT' : 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: unixNano(step.startedAt),
      endTimeUnixNano: unixNano(step.finishedAt ?? step.startedAt),
      attributes: [
        attr('bot_buffet.step.sequence', step.sequence),
        attr('bot_buffet.step.type', step.type),
        attr('bot_buffet.step.status', step.status),
        attr('bot_buffet.step.duration_ms', step.durationMs ?? 0),
        attr('bot_buffet.step.redacted', String(step.redacted)),
      ],
      status: { code: STEP_STATUS[step.status] },
    }));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [attr('service.name', 'bot-buffet'), attr('service.version', serviceVersion)],
        },
        scopeSpans: [
          {
            scope: { name: 'bot-buffet.orchestrator', version: serviceVersion },
            spans: [root, ...spans],
          },
        ],
      },
    ],
  };
}

export interface MetricPoint {
  name: string;
  value: number;
  unit: string;
}

/** Prometheus-style exposition of harness counters for scrape-based collectors. */
export function renderMetrics(points: MetricPoint[]): string {
  return points
    .filter((point) => Number.isFinite(point.value))
    .map(
      (point) =>
        `# TYPE ${point.name} gauge\n# UNIT ${point.name} ${point.unit}\n${point.name} ${point.value}`,
    )
    .join('\n');
}
