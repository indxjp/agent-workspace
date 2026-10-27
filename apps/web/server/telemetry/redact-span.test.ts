import { describe, expect, it, vi } from 'vitest';
import type { Span } from '@opentelemetry/api';
import * as tracing from '@opentelemetry/sdk-trace';
import { redactingExporter, redactSpanStart, redactTriggerSecret } from './redact-span';

function fakeSpan() {
  return { updateName: vi.fn(), setAttribute: vi.fn() };
}

describe('trigger secret redaction', () => {
  it('redacts the secret in the span name and each url attribute', () => {
    const span = fakeSpan();
    const attrs = {
      'http.target': '/api/triggers/t1/fire/s3cret?x=1',
      'http.url': 'https://h.example/api/triggers/t1/fire/s3cret',
      'url.path': '/api/triggers/t1/fire/s3cret',
      'url.full': 'https://h.example/api/triggers/t1/fire/s3cret?x=1',
      'next.route': '/api/triggers/[id]/fire/[secret]',
    };
    redactSpanStart(span as unknown as Span, 'POST /api/triggers/t1/fire/s3cret', attrs);
    expect(span.updateName).toHaveBeenCalledWith('POST /api/triggers/t1/fire/[redacted]');
    expect(span.setAttribute).toHaveBeenCalledWith(
      'http.target',
      '/api/triggers/t1/fire/[redacted]?x=1',
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      'http.url',
      'https://h.example/api/triggers/t1/fire/[redacted]',
    );
    expect(span.setAttribute).toHaveBeenCalledWith('url.path', '/api/triggers/t1/fire/[redacted]');
    expect(span.setAttribute).toHaveBeenCalledWith(
      'url.full',
      'https://h.example/api/triggers/t1/fire/[redacted]?x=1',
    );
    expect(span.setAttribute).toHaveBeenCalledTimes(4);
  });

  it('leaves non-fire URLs unchanged', () => {
    const span = fakeSpan();
    redactSpanStart(span as unknown as Span, 'GET /api/runs', { 'http.target': '/api/runs?x=1' });
    expect(span.updateName).not.toHaveBeenCalled();
    expect(span.setAttribute).not.toHaveBeenCalled();
    expect(redactTriggerSecret('/api/runs')).toBe('/api/runs');
  });
});

describe('redacting exporter', () => {
  it('redacts attributes set after span start, and event attributes, at export', async () => {
    const memory = new tracing.InMemorySpanExporter();
    const provider = new tracing.TracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor({ exporter: redactingExporter(memory) })],
    });
    const span = provider.getTracer('t').startSpan('POST /api/triggers/t1/fire/s3cret');
    span.setAttribute('http.target', '/api/triggers/t1/fire/s3cret');
    span.setAttribute('http.status_code', 202);
    span.addEvent('e', { 'url.full': 'https://h/api/triggers/t1/fire/s3cret' });
    span.end();
    const [exported] = memory.getFinishedSpans();
    expect(exported?.name).toBe('POST /api/triggers/t1/fire/[redacted]');
    expect(exported?.attributes['http.target']).toBe('/api/triggers/t1/fire/[redacted]');
    expect(exported?.attributes['http.status_code']).toBe(202);
    expect(exported?.events[0]?.attributes?.['url.full']).toBe(
      'https://h/api/triggers/t1/fire/[redacted]',
    );
    await provider.shutdown();
  });
});
