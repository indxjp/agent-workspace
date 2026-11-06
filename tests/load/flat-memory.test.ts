/** Self-test: the flat-memory harness reports a streaming pipe as flat and can fail on a buffer. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  generatedBody,
  heldMemory,
  LOAD_BYTES,
  measureRssGrowth,
  MiB,
  NEW_SPACE_CREDIT_BOUND,
  newSpaceCredit,
  peakRssGrowth,
  warmHttpTransport,
} from './flat-memory.js';

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
              next += 4 * MiB;
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
  it(
    'catches a server that buffers a body it receives over HTTP',
    { timeout: 60_000 },
    async () => {
      // measureRssGrowth subtracts up to NEW_SPACE_CREDIT_BOUND of empty new space, so the server
      // holds more than 200 MiB plus that credit: 256 MiB alone measured 192-197 MiB on CI.
      const total = 200 * MiB + NEW_SPACE_CREDIT_BOUND + 64 * MiB;
      let held = 0;
      const chunks: Buffer[] = [];
      const server = createServer((req, res) => {
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          held = Buffer.concat(chunks).byteLength;
          res.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await warmHttpTransport();
        const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
        const { growth } = await measureRssGrowth(async (sample) => {
          // A variable, not a literal: the DOM `RequestInit` has no `duplex`.
          const init = { method: 'POST', body: generatedBody(total).body, duplex: 'half' as const };
          await (await fetch(url, init)).arrayBuffer();
          sample();
        });
        expect(held).toBe(total);
        expect(growth).toBeGreaterThan(200 * MiB);
      } finally {
        chunks.length = 0;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('credits empty new-space growth up to its bound and fails a reading past it', () => {
    const space = (committed: number, used = 0) => ({ committed, used });
    expect(newSpaceCredit(space(8 * MiB), space(4 * MiB))).toBe(0);
    // V8 grows new space past one 64 MiB step; empty pages up to the whole new space are credited.
    expect(newSpaceCredit(space(0), space(116 * MiB))).toBe(116 * MiB);
    expect(newSpaceCredit(space(0), space(NEW_SPACE_CREDIT_BOUND))).toBe(128 * MiB);
    expect(() => newSpaceCredit(space(0), space(NEW_SPACE_CREDIT_BOUND + 1))).toThrow(
      /new space grew/u,
    );
  });

  it('never credits new space that live objects still use', () => {
    const space = (committed: number, used = 0) => ({ committed, used });
    expect(newSpaceCredit(space(MiB), space(100 * MiB, 60 * MiB))).toBe(39 * MiB);
    expect(newSpaceCredit(space(MiB), space(100 * MiB, 100 * MiB))).toBe(0);
  });

  it('reports the new-space growth a reading subtracted', async () => {
    const reading = await measureRssGrowth(async (sample) => {
      sample();
      await Promise.resolve();
    });
    expect(reading.newSpaceGrowth).toBeGreaterThanOrEqual(0);
    expect(reading.newSpaceGrowth).toBeLessThanOrEqual(NEW_SPACE_CREDIT_BOUND);
  });

  it('reads held memory as anonymous and shared pages, resident or swapped', () => {
    const held = heldMemory();
    if (process.platform !== 'linux') {
      expect(held).toBeGreaterThan(0);
      return;
    }
    // A swapped page is still held: plain RSS dropped it, so a full-suite run under memory
    // pressure read the 64 MiB formData() negative control as 20 MiB.
    const status = readFileSync('/proc/self/status', 'utf8');
    const field = (name: string): number =>
      Number(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'mu').exec(status)?.[1]) * 1024;
    const expected = field('RssAnon') + field('RssShmem') + field('VmSwap');
    expect(Number.isFinite(expected)).toBe(true);
    // Read a moment apart, so a little allocation between the two readings is allowed.
    expect(Math.abs(held - expected)).toBeLessThan(16 * MiB);
    expect(held).toBeLessThan(process.memoryUsage().rss + field('VmSwap'));
  });
});
