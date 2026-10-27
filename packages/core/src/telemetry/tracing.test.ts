import { describe, expect, it, vi } from 'vitest';

import { createJsonLogger } from './logger.js';
import { inServerSpan, SpanKind, spanTraceparent, startTracing } from './tracing.js';

type Exporter = NonNullable<Parameters<typeof startTracing>[3]>;
type Exported = Parameters<Exporter['export']>[0][number];

/** An in-memory exporter, typed from `startTracing` so the test needs no SDK import of its own. */
function memoryExporter(): { exporter: Exporter; spans: Exported[] } {
  const spans: Exported[] = [];
  return {
    spans,
    exporter: {
      export(batch, done) {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    },
  };
}

const lines: string[] = [];
const log = createJsonLogger({ service: 'test', write: (_level, line) => lines.push(line) });

const CALLER = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('startTracing', () => {
  it('starts nothing and records nothing when OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    const { exporter } = memoryExporter();
    await expect(startTracing('test', {}, log, exporter)).resolves.toBeNull();
    await expect(
      startTracing('test', { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }, log),
    ).resolves.toBeNull();
    await inServerSpan('POST /run', CALLER, {}, (span) => {
      expect(span.isRecording()).toBe(false);
      expect(spanTraceparent(span)).toBeNull();
      return Promise.resolve();
    });
  });

  it('records a server span that continues the caller trace id', async () => {
    const { exporter, spans } = memoryExporter();
    const tracing = await startTracing(
      'test',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid:4318/' },
      log,
      exporter,
    );
    expect(tracing).not.toBeNull();
    let forwarded: string | null = null;
    await inServerSpan('POST /run', CALLER, { 'http.route': '/run' }, (span) => {
      forwarded = spanTraceparent(span);
      return Promise.resolve();
    });
    // A flush exports what has ended without stopping the SDK.
    await tracing?.flush(1_000);
    expect(spans).toHaveLength(1);
    // A malformed header is no parent: the span is a fresh root, never an error.
    await inServerSpan('POST /run', 'not-a-traceparent', {}, () => Promise.resolve());
    await tracing?.shutdown();

    const [joined, root] = spans;
    expect(joined?.kind).toBe(SpanKind.SERVER);
    expect(joined?.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(joined?.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
    expect(joined?.attributes).toEqual({ 'http.route': '/run' });
    expect(forwarded).toBe(
      `00-0af7651916cd43dd8448eb211c80319c-${joined?.spanContext().spanId ?? ''}-01`,
    );
    expect(root?.parentSpanContext).toBeUndefined();
    expect(root?.spanContext().traceId).not.toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('logs one error and leaves tracing off when the SDK fails to start', async () => {
    vi.resetModules();
    vi.doMock('@opentelemetry/sdk-node', () => {
      throw new Error('cannot load the SDK');
    });
    try {
      const fresh = await import('./tracing.js');
      lines.length = 0;
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pass@collector.example:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer otlp-header-secret',
      };
      await expect(fresh.startTracing('test', env, log)).resolves.toBeNull();
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(line).toMatchObject({
        level: 'error',
        msg: 'tracing failed to start; continuing without spans',
        collector: 'collector.example:4318',
      });
      expect(lines[0]).not.toMatch(/pass|otlp-header-secret/u);
    } finally {
      vi.doUnmock('@opentelemetry/sdk-node');
      vi.resetModules();
    }
  });
});
