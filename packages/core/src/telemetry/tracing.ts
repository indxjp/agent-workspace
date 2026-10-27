/**
 * OpenTelemetry spans for the runner and the gateway (ADR-0155, owner decision D10).
 *
 * The SDK starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the same switch and packages the
 * web app uses; otherwise nothing is imported beyond `@opentelemetry/api`, whose spans are no-ops.
 * Attributes are set explicitly by the callers and are allow-listed by construction: no URL, header,
 * body, prompt or response ever becomes one, and no auto-instrumentation is registered.
 */
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace';

import type { Logger } from './logger.js';
import { parseTraceparent } from './traceparent.js';

export { SpanKind, SpanStatusCode, type Span };

const TRACER = 'agent-workspace';

export interface Tracing {
  /**
   * Exports the queued spans, waiting at most `timeoutMs`: for a process that may be frozen after
   * it answers (a serverless function), where the batch timer might never fire.
   */
  readonly flush: (timeoutMs: number) => Promise<void>;
  /** Flushes the queued spans, stops the exporter and unregisters the SDK from the API. */
  readonly shutdown: () => Promise<void>;
}

/** The collector's host, the one configuration value a start-up failure may name. */
function collectorHost(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

/**
 * Starts the OpenTelemetry SDK when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and returns `null` without
 * loading the SDK when it is not. The service name is `OTEL_SERVICE_NAME`, else `service`. Tracing is
 * optional: a failure to start is logged once and also returns `null`, so the caller serves without
 * spans. `exporter` replaces the OTLP exporter (tests).
 */
export async function startTracing(
  service: string,
  env: Readonly<Record<string, string | undefined>>,
  log: Logger,
  exporter?: SpanExporter,
): Promise<Tracing | null> {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!endpoint) return null;
  try {
    return await startSdk(service, endpoint, env['OTEL_SERVICE_NAME']?.trim(), exporter);
  } catch (error) {
    log.error('tracing failed to start; continuing without spans', {
      collector: collectorHost(endpoint),
      error,
    });
    return null;
  }
}

async function startSdk(
  service: string,
  endpoint: string,
  serviceName: string | undefined,
  exporter: SpanExporter | undefined,
): Promise<Tracing> {
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace');
  const spanExporter =
    exporter ??
    new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/u, '')}/v1/traces`,
    });
  const processor = new BatchSpanProcessor({ exporter: spanExporter });
  const sdk = new NodeSDK({ serviceName: serviceName || service, spanProcessors: [processor] });
  sdk.start();
  return {
    async flush(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      // A failed export is the exporter's to report; a flush never fails the response it follows.
      await Promise.race([processor.forceFlush().catch(() => undefined), timedOut]);
      clearTimeout(timer);
    },
    async shutdown() {
      await sdk.shutdown();
      // The API's registrations are process-global; clearing them lets a later start begin clean.
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

/**
 * Runs `work` in a span under `parent` (the active context by default). A thrown error marks the
 * span failed without recording the error's message, which may carry caller text.
 */
export function inSpan<T>(
  name: string,
  kind: SpanKind,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  return trace
    .getTracer(TRACER)
    .startActiveSpan(name, { kind, attributes }, parent, async (span) => {
      try {
        return await work(span);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}

/**
 * Runs `work` in a SERVER span that continues the request's adopted W3C `traceparent`, so the span's
 * trace id is the `traceId` its log lines carry. An invalid or absent header starts a root span.
 */
export function inServerSpan<T>(
  name: string,
  traceparent: string | null | undefined,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  const caller = parseTraceparent(traceparent);
  const parent =
    caller === null
      ? ROOT_CONTEXT
      : trace.setSpanContext(ROOT_CONTEXT, {
          traceId: caller.traceId,
          spanId: caller.parentId,
          traceFlags: Number.parseInt(caller.flags, 16),
          isRemote: true,
        });
  return inSpan(name, SpanKind.SERVER, attributes, work, parent);
}

/** The `traceparent` that makes `span` the parent of a downstream call; `null` when it does not record. */
export function spanTraceparent(span: Span): string | null {
  if (!span.isRecording()) return null;
  const { traceId, spanId, traceFlags } = span.spanContext();
  return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;
}
