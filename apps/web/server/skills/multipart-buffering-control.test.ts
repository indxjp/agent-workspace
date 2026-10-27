/**
 * The negative control for `multipart-import.test.ts`'s memory bound (the storage design, §07
 * US-STO-08): `Request.formData()` holds the whole body, so a body larger than the 15 MiB test's
 * 2x bound reads over that bound with the same measurement, which shows the bound can fail. The
 * body is 64 MiB so the reading clears the bound whatever the allocator and young generation did.
 */
// @story US-STO-08
import { expect, it } from 'vitest';

import {
  generatedBody,
  MiB,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';

it('[US-STO-08][api][sdk] negative control: formData() holds the whole body, so the bound can fail', async () => {
  const size = 64 * MiB;
  const boundary = 'skill-test-boundary';
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\npricing\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data/table.bin"\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const source = generatedBody(size);
  await warmHttpTransport();
  const reader = source.body.getReader();
  let step: 'head' | 'content' | 'tail' = 'head';
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (step === 'head') {
        step = 'content';
        return controller.enqueue(head);
      }
      if (step === 'content') {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        step = 'tail';
        return controller.enqueue(tail);
      }
      return controller.close();
    },
  });

  const buffered = await peakRssGrowth(async (sampled) => {
    const init = {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half' as const,
    };
    const form = await new Request('https://example.invalid/api/skills', init).formData();
    sampled();
    expect(form.get('name')).toBe('pricing');
  });
  expect(buffered).toBeGreaterThan(2 * 15 * MiB);
}, 120_000);
