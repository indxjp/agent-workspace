import { expect, it } from 'vitest';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import {
  generatedBody,
  MiB,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';
import type { SkillImportFixture } from './multipart-import.harness.test-support';
import { multipart, skillMdPart, namePart, bigPart } from './multipart-import.fixture.test-support';
export function registerSkillImportMemoryTests(
  getFixture: () => Pick<SkillImportFixture, 'install' | 'post' | 'catalog'>,
) {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] a 15 MiB multipart body streams in bounded memory', async () => {
    const testContext = getFixture();

    const size = 15 * MiB;
    const inner = createInMemoryObjectStore();
    let sample: () => void = () => undefined;
    // Keeps a small object (SKILL.md) and drains a large one, so the window reads the route and
    // the service, not the test's own store.
    testContext.install({
      ...inner,
      write: async (key, body, options) => {
        if (body instanceof Uint8Array) return inner.write(key, body, options);
        const kept: Uint8Array[] = [];
        let seen = 0;
        for await (const chunk of body) {
          const before = seen;
          seen += chunk.byteLength;
          if (seen <= 64 * 1024) kept.push(new Uint8Array(chunk));
          if (Math.floor(seen / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
        }
        if (seen <= 64 * 1024) return inner.write(key, Buffer.concat(kept), options);
        return { sizeBytes: seen, contentType: null, etag: 'drained', lastModified: new Date() };
      },
    });

    // Built before the baseline: the generator's ring is the source, not the route.
    const source = generatedBody(size);
    const sent = multipart([namePart(), skillMdPart(), bigPart(source, size)]);
    await warmHttpTransport();
    const streamed = await peakRssGrowth(async (sampled) => {
      sample = sampled;
      const response = await testContext.post(sent);
      expect(response.status, await response.clone().text()).toBe(201);
    });
    expect(streamed).toBeLessThan(2 * size);
    expect(await (await testContext.catalog()).get('.skills/pricing/data/table.bin')).toMatchObject(
      {
        sizeBytes: size,
        sha256: await source.sha256,
      },
    );
  }, 120_000);
}
