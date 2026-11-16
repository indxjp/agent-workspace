import { expect, it } from 'vitest';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';
import {
  generatedBody,
  MiB,
  NEW_SPACE_CREDIT_BOUND,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';
import type { SessionBlobFixture } from './state-blobs.harness.test-support';

export function registerSessionBlobMemoryTests(
  getFixture: () => Pick<SessionBlobFixture, 'harness'>,
) {
  // @story US-STO-09
  it('[US-STO-09][load][sdk] a PUT at the cap streams to the store and keeps memory growth under 16 MiB', async () => {
    const testContext = getFixture();

    const size = SESSION_STATE_BLOB_MAX_BYTES;
    const inner = createInMemoryObjectStore();
    let sample: () => void = () => undefined;
    // Drains the body instead of keeping it, so what the window reads is the route, the store
    // and the service, not the test's own object store.
    const h = await testContext.harness({
      objects: {
        ...inner,
        write: async (_key, body) => {
          let seen = 0;
          if (body instanceof Uint8Array) {
            seen = body.byteLength;
          } else {
            for await (const chunk of body) {
              const before = seen;
              seen += chunk.byteLength;
              if (Math.floor(seen / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
            }
          }
          return {
            sizeBytes: seen,
            contentType: null,
            etag: 'drained',
            lastModified: new Date(),
          };
        },
      },
    });
    const api = h.as(h.user);

    // Built before each baseline: the generator's 16 MiB ring is the source, not the route.
    let source = generatedBody(size);
    await warmHttpTransport();
    const streamed = await peakRssGrowth(async (sampled) => {
      sample = sampled;
      const response = await api.putStream(source.body);
      expect(response.status, await response.clone().text()).toBe(204);
    });
    expect(streamed).toBeLessThan(16 * MiB);
    expect(await h.stored()).toMatchObject({ sizeBytes: size, sha256: await source.sha256 });

    // One byte over the cap, with no Content-Length to refuse it early: 413, and nothing kept.
    const over = await api.putStream(generatedBody(size + 1).body);
    expect(over.status).toBe(413);
    expect(await h.stored()).toMatchObject({ sizeBytes: size });
    await expect(h.unsettled()).resolves.toEqual([]);

    // Negative control: buffering a body whole, as the route did, must read high. It is larger
    // than the blob by NEW_SPACE_CREDIT_BOUND, the RSS a reading may credit.
    const controlSize = size + NEW_SPACE_CREDIT_BOUND;
    source = generatedBody(controlSize);
    const buffered = await peakRssGrowth(async (sampled) => {
      const init = { method: 'PUT', body: source.body, duplex: 'half' as const };
      const read = await new Request('https://example.invalid/state-blobs', init).arrayBuffer();
      sampled();
      expect(read.byteLength).toBe(controlSize);
    });
    expect(buffered).toBeGreaterThanOrEqual(16 * MiB);
  }, 120_000);
}
