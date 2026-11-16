import { expect, it } from 'vitest';
import {
  createInMemoryObjectStore,
  storageObjectName,
  streamToBytes,
} from '@agent-workspace/core/storage';
import {
  generatedBody,
  MiB,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';
import { toResponse } from './http';
import type { FileReadFixture } from './list-download.harness.test-support';

export function registerFileReadMemoryTests(
  getFixture: () => Pick<FileReadFixture, 'world' | 'install' | 'download' | 'storage' | 'ctxOf'>,
) {
  // @story US-STO-05
  it('[US-STO-05][load][sdk] a 60 MiB download keeps server memory growth under 16 MiB', async () => {
    const testContext = getFixture();

    const size = 60 * MiB;
    const catalog = await testContext.world.catalogs.forWorkspace(testContext.world.a.workspaceId);
    const objectId = crypto.randomUUID();
    const reserved = await catalog.reserve('big/60mib.bin', {
      ownerPrincipalId: testContext.world.a.principalId,
      sizeBytes: size,
      contentType: 'application/octet-stream',
      objectId,
      area: 'files',
    });
    await catalog.confirm(reserved.row, {
      sizeBytes: size,
      contentType: 'application/octet-stream',
    });
    const name = storageObjectName(testContext.world.a.workspaceId, 'files', objectId);
    const inner = createInMemoryObjectStore();
    // Built before each baseline: the generator's 16 MiB ring is the source, not the download
    // path, so allocating it inside the window read exactly 16 MiB of growth (CI run 39910900763).
    let source = generatedBody(size);
    testContext.install({
      ...inner,
      read: (key, options) =>
        key === name
          ? Promise.resolve({
              meta: {
                sizeBytes: size,
                contentType: null,
                etag: 'generated',
                lastModified: new Date(),
              },
              range: null,
              body: source.body,
            })
          : inner.read(key, options),
    });

    const drain = async (response: Response, sample: () => void): Promise<number> => {
      let seen = 0;
      if (response.body === null) throw new Error('the response has no body');
      for await (const chunk of response.body) {
        const before = seen;
        seen += chunk.byteLength;
        if (Math.floor(seen / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
      }
      return seen;
    };

    await warmHttpTransport();
    const streamed = await peakRssGrowth(async (sample) => {
      const response = await testContext.download('a', 'big/60mib.bin');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe(String(size));
      expect(await drain(response, sample)).toBe(size);
    });
    expect(streamed).toBeLessThan(16 * MiB);

    // Negative control: the same body buffered whole and sent as the binary arm must read high.
    source = generatedBody(size);
    const buffered = await peakRssGrowth(async (sample) => {
      const opened = await testContext.storage.open(
        testContext.ctxOf(testContext.world.a),
        reserved.row,
      );
      if (opened === null) throw new Error('the object did not open');
      const bytes = await streamToBytes(opened.body);
      sample();
      const response = toResponse({
        status: 200,
        kind: 'binary',
        body: bytes,
        contentType: 'application/octet-stream',
        filename: '60mib.bin',
      });
      expect(await drain(response, sample)).toBe(size);
    });
    expect(buffered).toBeGreaterThanOrEqual(16 * MiB);
  }, 120_000);
}
