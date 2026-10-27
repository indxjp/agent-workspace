import { describe, expect, it } from 'vitest';

import { readBytes } from './streams.js';

function chunked(parts: readonly string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[next];
      next += 1;
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('readBytes', () => {
  it('collects a body under the cap', async () => {
    const bytes = await readBytes(chunked(['ab', 'cd']), 10);
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('abcd');
  });

  it('collects a body of exactly the cap', async () => {
    const bytes = await readBytes(chunked(['ab', 'cd']), 4);
    expect(bytes?.byteLength).toBe(4);
  });

  it('answers null and cancels the source once the cap is passed', async () => {
    let cancelled = false;
    const bytes = await readBytes(
      chunked(['ab', 'cd', 'e'], () => {
        cancelled = true;
      }),
      4,
    );
    expect(bytes).toBeNull();
    expect(cancelled).toBe(true);
  });

  it('releases the reader when a read rejects', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('source failed');
      },
    });
    await expect(readBytes(stream, 10)).rejects.toThrow('source failed');
    expect(stream.locked).toBe(false);
  });

  it('releases the reader once the body is read', async () => {
    const stream = chunked(['ab']);
    await readBytes(stream, 10);
    expect(stream.locked).toBe(false);
  });
});
