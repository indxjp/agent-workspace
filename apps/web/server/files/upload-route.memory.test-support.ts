import { expect, it } from 'vitest';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import {
  generatedBody,
  MiB,
  NEW_SPACE_CREDIT_BOUND,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';
import type { FileUploadFixture } from './upload-route.harness.test-support';

export function registerFileUploadMemoryTests(
  getFixture: () => Pick<FileUploadFixture, 'install' | 'post' | 'catalogA'>,
) {
  // @story US-STO-05
  it('[US-STO-05][load][sdk] a 60 MiB upload keeps server memory growth under 16 MiB', async () => {
    const testContext = getFixture();

    const size = 60 * MiB;
    const inner = createInMemoryObjectStore();
    let sample: () => void = () => undefined;
    // Drains the body instead of keeping it, so what the window reads is the route and the
    // service, not the test's own store.
    testContext.install({
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
        return { sizeBytes: seen, contentType: null, etag: 'drained', lastModified: new Date() };
      },
    });

    // Built before each baseline: the generator's 16 MiB ring is the source, not the route.
    let source = generatedBody(size);
    await warmHttpTransport();
    const streamed = await peakRssGrowth(async (sampled) => {
      sample = sampled;
      const response = await testContext.post('big/60mib.bin', source.body);
      expect(response.status, await response.clone().text()).toBe(201);
    });
    expect(streamed).toBeLessThan(16 * MiB);
    expect(await (await testContext.catalogA()).get('big/60mib.bin')).toMatchObject({
      sizeBytes: size,
      sha256: await source.sha256,
    });
    expect((await testContext.post('big/viewer.bin', generatedBody(MiB).body, 'v')).status).toBe(
      403,
    );

    // Negative control: buffering a body whole, as the legacy route did, must read high. It is
    // larger than the upload by NEW_SPACE_CREDIT_BOUND: RSS the reading credits or that the
    // streamed phase freed can absorb a 60 MiB buffer (it read 11 MiB in a merge-queue run).
    const controlSize = size + NEW_SPACE_CREDIT_BOUND;
    source = generatedBody(controlSize);
    const buffered = await peakRssGrowth(async (sampled) => {
      const init = { method: 'POST', body: source.body, duplex: 'half' as const };
      const read = await new Request('https://example.invalid/api/files', init).arrayBuffer();
      sampled();
      expect(read.byteLength).toBe(controlSize);
    });
    expect(buffered).toBeGreaterThanOrEqual(16 * MiB);
  }, 120_000);
}
