/** Self-test: the flat-memory harness reports a streaming pipe as flat and can fail on a buffer. */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generatedBody, LOAD_BYTES, MiB, peakRssGrowth, warmHttpTransport } from './flat-memory.js';

describe('flat-memory harness', () => {
  it('reports a streaming pipe as flat', { timeout: 60_000 }, async () => {
    const { body, sha256 } = generatedBody(LOAD_BYTES);
    const seen = createHash('sha256');
    let bytes = 0;
    let next = 0;
    const growth = await peakRssGrowth(async (sample) => {
      await body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()).pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            seen.update(chunk);
            bytes += chunk.byteLength;
            if (bytes >= next) {
              sample();
              next += 32 * MiB;
            }
          },
        }),
      );
      sample();
    });
    expect(bytes).toBe(LOAD_BYTES);
    expect(seen.digest('hex')).toBe(await sha256);
    expect(growth).toBeLessThan(64 * MiB);
  });

  it('catches a consumer that buffers', { timeout: 60_000 }, async () => {
    // The transport warm-up runs first: it must not hide a buffering consumer.
    await warmHttpTransport();
    const total = 256 * MiB;
    let held = 0;
    const growth = await peakRssGrowth(async (sample) => {
      const buffered = await new Response(generatedBody(total).body).arrayBuffer();
      sample();
      held = buffered.byteLength;
    });
    expect(held).toBe(total);
    expect(growth).toBeGreaterThan(200 * MiB);
  });
});
