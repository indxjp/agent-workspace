import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BodyTooLargeError, measure } from './measure';

function through(maxBytes: number, ...chunks: Uint8Array[]) {
  const measured = measure(maxBytes);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return { measured, read: new Response(source.pipeThrough(measured.stream)).arrayBuffer() };
}

describe('measure', () => {
  // @story US-STO-01
  it('[US-STO-01][unit][sdk] counts bytes and hashes the body it passes on unchanged', async () => {
    const chunks = [new TextEncoder().encode('hello '), new TextEncoder().encode('world')];
    const { measured, read } = through(100, ...chunks);

    const passed = new Uint8Array(await read);

    expect(new TextDecoder().decode(passed)).toBe('hello world');
    expect(measured.result()).toEqual({
      sizeBytes: 11,
      sha256: createHash('sha256').update('hello world').digest('hex'),
    });
  });

  // @story US-STO-01
  it('[US-STO-01][unit][sdk] passes exactly maxBytes and errors on the first byte past it', async () => {
    await expect(through(8, new Uint8Array(8)).read).resolves.toHaveProperty('byteLength', 8);
    await expect(through(8, new Uint8Array(5), new Uint8Array(4)).read).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});
