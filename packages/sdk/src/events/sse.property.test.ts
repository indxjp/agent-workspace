/**
 * Property test for {@link readSseFrames} (F-21 property 2): the frames a body yields do not depend
 * on how the network chunked it. On a failure fast-check prints the seed and path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readSseFrames, type SseFrame } from './sse.js';

/** Text built from the pieces a frame boundary is made of, plus multi-byte characters. */
const streamText = fc
  .array(
    fc.oneof(
      fc.constantFrom('\n', '\r', '\r\n', '\n\n', 'event: x', 'id: 7', 'at: t', 'data: '),
      fc.constantFrom(':', ' ', '{"a":1}', '"q"', 'é', '€', '😀'),
      fc.string({ maxLength: 4 }),
    ),
    { maxLength: 30 },
  )
  .map((pieces) => pieces.join(''));

/** The body split at the given byte offsets, which may fall inside a multi-byte character. */
function chunked(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const point of [...points, bytes.length]) {
    chunks.push(bytes.slice(start, point));
    start = point;
  }
  return chunks;
}

function body(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function frames(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const frame of readSseFrames(stream)) out.push(frame);
  return out;
}

describe('readSseFrames (property)', () => {
  it('yields the same frames for any chunking as for the body in one piece', async () => {
    await fc.assert(
      fc.asyncProperty(streamText, fc.array(fc.nat(), { maxLength: 12 }), async (text, cuts) => {
        const bytes = new TextEncoder().encode(text);
        const whole = await frames(body([bytes]));
        expect(await frames(body(chunked(bytes, cuts)))).toEqual(whole);
      }),
      { numRuns: 300 },
    );
  });
});
