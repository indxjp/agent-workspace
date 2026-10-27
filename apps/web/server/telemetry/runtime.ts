import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { parseTraceparent, type RunTelemetryAttributes } from '@agent-workspace/core/telemetry';
import { defineSlot } from '../runtime-slot';
import { redactingExporter, redactSpanStart } from './redact-span';

/**
 * The Runs screen is an operational convenience, not the durable run store. Keep its process-local
 * projection bounded so a long-lived control-plane process cannot retain one object for every run
 * it has ever observed. Insertion order makes the map a small LRU: an update refreshes a run and a
 * new run evicts the least-recently observed entry. The map lives on `globalThis` because Next.js
 * compiles `instrumentation.ts` (the writer) and the route handlers (the reader) into separate
 * module graphs; see `../runs/interrupt.ts`.
 */
export const RECENT_RUN_TELEMETRY_LIMIT = 1_000;

const slot = defineSlot<Map<string, RunTelemetryAttributes>>(
  '__agentWorkspaceRecentRunTelemetry__',
);

function recentRuns(): Map<string, RunTelemetryAttributes> {
  return slot.getOrCreate(() => new Map());
}

// Module-level on purpose: only one graph configures it; the OTel API holds the provider globally.
let sdk: NodeSDK | null = null;

export function configureTelemetryRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!endpoint) return Promise.resolve(false);
  if (sdk !== null) return Promise.resolve(true);
  const exporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/u, '')}/v1/traces` });
  // ADR-0144 D2: Next.js spans carry the request URL; the redactor runs before the exporter.
  const redactor: SpanProcessor = {
    onStart: (span) => redactSpanStart(span, span.name, span.attributes),
    onEnd: () => undefined,
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  sdk = new NodeSDK({
    spanProcessors: [redactor, new BatchSpanProcessor({ exporter: redactingExporter(exporter) })],
  });
  sdk.start();
  return Promise.resolve(true);
}

/**
 * The W3C `traceparent` of the active span, for a request to the runtime (F-04): the runner joins
 * its log lines to this trace. Empty when telemetry is off or no span is active, because without a
 * configured SDK the OpenTelemetry API propagates nothing.
 */
export function activeTraceHeaders(): Readonly<Record<string, string>> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier['traceparent'];
  return parseTraceparent(traceparent) === null || traceparent === undefined ? {} : { traceparent };
}

export function recordRunTelemetry(attributes: RunTelemetryAttributes): void {
  const runs = recentRuns();
  runs.delete(attributes.runId);
  runs.set(attributes.runId, attributes);
  while (runs.size > RECENT_RUN_TELEMETRY_LIMIT) {
    const oldestRunId = runs.keys().next().value;
    if (oldestRunId === undefined) break;
    runs.delete(oldestRunId);
  }
  const span = trace.getTracer('agent-workspace').startSpan('agent.run', {
    attributes: {
      'run.id': attributes.runId,
      'workspace.id': attributes.workspaceId,
      'agent.id': attributes.agentId,
      'run.status': attributes.status,
      ...(attributes.durationMs === null ? {} : { 'run.duration_ms': attributes.durationMs }),
      ...(attributes.costUsd === null ? {} : { 'run.cost_usd': attributes.costUsd }),
    },
  });
  if (attributes.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

/**
 * The projection `GET /api/metrics` serves, already scoped to one workspace.
 *
 * `workspaceId` is required, not optional, so no caller can compile its way back into the
 * pre-W9-SEC-116 shape of returning every workspace's runs. The route passes the `workspaceId`
 * of the verified `Principal` it authorised — never a value read from the request — see
 * `apps/web/app/api/metrics/route.ts` and `docs/adr/W9-SEC-116-scope-metrics-projection-by-principal-workspace.md`.
 */
export function recentRunTelemetry(workspaceId: string): readonly RunTelemetryAttributes[] {
  return [...recentRuns().values()].filter((entry) => entry.workspaceId === workspaceId);
}
