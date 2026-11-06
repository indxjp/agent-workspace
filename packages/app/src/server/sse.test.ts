import { describe, expect, it } from 'vitest';

import {
  isWritableEventName,
  KEEPALIVE_MS,
  RETRY_MS,
  SSE_HEADERS,
  SSE_KEEPALIVE,
  sseControlFrame,
  sseEventFrame,
  sseResponse,
  sseRetryFrame,
} from './sse.js';

/** The frame name `EventSource` reserves; spelled once, so a grep finds only code writing it. */
const FORBIDDEN = 'error';

async function bodyOf(response: Response): Promise<string> {
  return new Response(response.body).text();
}

describe('the app kit SSE writer', () => {
  it('answers with exactly the three headers', () => {
    expect(Object.keys(SSE_HEADERS)).toEqual([
      'Content-Type',
      'Cache-Control',
      'X-Accel-Buffering',
    ]);
    const response = sseResponse(() => Promise.resolve(), { onCancel: () => undefined });
    expect(response.status).toBe(200);
    expect([...response.headers.keys()]).toEqual([
      'cache-control',
      'content-type',
      'x-accel-buffering',
    ]);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  });

  it('never writes a frame named error, nor one outside the event-name grammar', () => {
    expect(isWritableEventName('error')).toBe(false);
    expect(sseEventFrame('error', '1', undefined, {})).toBeNull();
    expect(sseEventFrame('bad name', '1', undefined, {})).toBeNull();
    expect(sseEventFrame('a\nevent: done', '1', undefined, {})).toBeNull();
    expect(sseEventFrame('', null, undefined, {})).toBeNull();
    expect(sseEventFrame('channel-event', '12', undefined, { a: 'x\ny' })).toBe(
      'event: channel-event\nid: 12\ndata: {"a":"x\\ny"}\n\n',
    );
  });

  it('writes an id only when it is a wire event id', () => {
    expect(sseEventFrame('x', `1\nevent: ${FORBIDDEN}`, undefined, null)).toBe(
      'event: x\ndata: null\n\n',
    );
    expect(sseEventFrame('x', '3.1', '2026-01-01T00:00:00.000Z', 1)).toBe(
      'event: x\nid: 3.1\nat: 2026-01-01T00:00:00.000Z\ndata: 1\n\n',
    );
  });

  it('writes the retry frame first, with digits only', async () => {
    expect(sseRetryFrame()).toBe(`retry: ${String(RETRY_MS)}\n\n`);
    expect(sseRetryFrame(1500.7)).toBe('retry: 1500\n\n');
    expect(sseRetryFrame(-1)).toBe(`retry: ${String(RETRY_MS)}\n\n`);
    expect(sseRetryFrame(Number.NaN)).toBe(`retry: ${String(RETRY_MS)}\n\n`);
    const response = sseResponse(
      (writer) => {
        writer.write(sseControlFrame('done', {}));
        return Promise.resolve();
      },
      { onCancel: () => undefined },
    );
    expect(await bodyOf(response)).toBe(`retry: ${String(RETRY_MS)}\n\nevent: done\ndata: {}\n\n`);
  });

  it('keeps a keep-alive comment inside a proxy idle timeout', () => {
    expect(KEEPALIVE_MS).toBeLessThan(60_000);
    expect(SSE_KEEPALIVE).toBe(': keepalive\n\n');
  });

  it('writes a failure in-band with onFailure, as a 200, never with its words', async () => {
    const response = sseResponse(() => Promise.reject(new Error('password=hunter2')), {
      onFailure: (writer) => writer.write(sseControlFrame('run-failed', { status: 'unknown' })),
      onCancel: () => undefined,
    });
    expect(response.status).toBe(200);
    const text = await bodyOf(response);
    expect(text).toContain('event: run-failed');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(`event: ${FORBIDDEN}`);
  });

  it('calls onCancel when the client goes away, and writes nothing after', async () => {
    let cancelled = 0;
    let write: ((chunk: string) => void) | undefined;
    const response = sseResponse(
      (writer) => {
        write = (chunk) => writer.write(chunk);
        return new Promise(() => undefined);
      },
      { onCancel: () => (cancelled += 1) },
    );
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value).toBeDefined();
    await reader?.cancel();
    write?.(sseControlFrame('done', {}));
    expect(cancelled).toBe(1);
  });
});
