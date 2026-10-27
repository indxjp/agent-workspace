/**
 * Shared flat-memory harness. Load tests live in `tests/load/*.test.ts`, import this file, and
 * assert how far the process RSS grows while a large body moves. The full 1 GiB runs only with
 * `AW_LOAD_TESTS=1` (one CI step sets it, #1650); otherwise 32 MiB keeps local and PR runs fast.
 * It imports nothing from Vitest, so any test can use it.
 */
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getHeapSpaceStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

export const MiB = 1024 * 1024;

/** 1 GiB when AW_LOAD_TESTS=1, else 32 MiB. */
export const LOAD_BYTES: number = process.env['AW_LOAD_TESTS'] === '1' ? 1024 * MiB : 32 * MiB;

// Collecting before each reading measures memory the transfer still holds, not garbage the
// collector has not reached yet.
setFlagsFromString('--expose-gc');
const gc: unknown = runInNewContext('gc');
function collect(): void {
  if (typeof gc !== 'function') throw new Error('flat-memory: --expose-gc did not expose gc()');
  Reflect.apply(gc, undefined, []);
}

/** Bytes V8 has committed to its young generation (new space). */
function newSpaceBytes(): number {
  const space = getHeapSpaceStatistics().find((entry) => entry.space_name === 'new_space');
  return space?.physical_space_size ?? 0;
}

/**
 * Peak RSS growth (bytes) while `work` runs; forces GC before the baseline and before each sample.
 * Call `sample()` inside `work` while the data is still referenced; the trailing sample alone
 * cannot see memory `work` has already released.
 *
 * Growth of V8's young generation is not counted. Under a high allocation rate V8 enlarges new
 * space (by 64 MiB in one step, measured on Node 24), and a full GC empties it but does not give
 * the pages back, so RSS jumped by about 64 MiB at random with nothing retained (PR #1740: up to
 * 104 MiB on S3 and 98 MiB on GCS, 64 MiB of it new space). New space is bounded by V8 whatever the payload, and
 * the forced full GC before every sample promotes anything still live out of it, so retained data
 * (old space, ArrayBuffer backing stores, native buffers) is still counted. A shrinking new space
 * is not credited.
 */
export async function peakRssGrowth(work: (sample: () => void) => Promise<void>): Promise<number> {
  collect();
  const baseline = process.memoryUsage().rss;
  const newSpaceBaseline = newSpaceBytes();
  let peak = 0;
  const sample = (): void => {
    collect();
    const newSpaceGrowth = Math.max(0, newSpaceBytes() - newSpaceBaseline);
    peak = Math.max(peak, process.memoryUsage().rss - baseline - newSpaceGrowth);
  };
  await work(sample);
  sample();
  return peak;
}

/**
 * A ReadableStream of `total` bytes from a ring of 16 reused 1 MiB chunks; `sha256` resolves to the
 * hex digest of everything produced and rejects if the stream is cancelled. A consumer that keeps
 * 16 or more chunks sees reused bytes, so only its memory reading, not its content, can be trusted.
 */
export function generatedBody(total: number): {
  body: ReadableStream<Uint8Array>;
  sha256: Promise<string>;
} {
  // Filled now so the ring is resident before the baseline and its reuse is not counted as growth.
  // 16 chunks outlast an uploader that holds a whole 8 MiB part plus the chunk that overflows it.
  const ring = new Uint8Array(16 * MiB).fill(0);
  const hash = createHash('sha256');
  const chunks = Math.ceil(total / MiB);
  let index = 0;
  let settle: { resolve: (digest: string) => void; reject: (reason: Error) => void };
  const sha256 = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  sha256.catch(() => undefined);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks) {
        controller.close();
        settle.resolve(hash.digest('hex'));
        return;
      }
      const size = Math.min(MiB, total - index * MiB);
      const offset = (index % 16) * MiB;
      const chunk = ring.subarray(offset, offset + size);
      chunk.fill(index % 251);
      hash.update(chunk);
      controller.enqueue(chunk);
      index += 1;
    },
    cancel() {
      settle.reject(new Error('generatedBody was cancelled before its last byte'));
    },
  });
  return { body, sha256 };
}

/** `bytes` of one reused 64 KiB chunk, so the warm-up keeps no payload of its own alive. */
function* repeated(bytes: number): Generator<Buffer> {
  const chunk = Buffer.alloc(64 * 1024, 7);
  for (let left = bytes; left > 0; left -= chunk.byteLength) yield chunk;
}

/**
 * Moves `bytes` up and then down over a local HTTP socket pair, with both `fetch` and
 * `node:http` as the client. Call it before `peakRssGrowth` in a test whose body crosses HTTP.
 *
 * A process's first large HTTP transfer costs native memory once. On CI the first 128 MiB through
 * the runner proxy read 25.1 MiB and eleven more in the same process read 0-0.8 MiB (PR #1757),
 * with no heap or ArrayBuffer growth. S3 read 41-56 MiB locally without this warm-up and 13-14 MiB
 * with it. The warm-up never touches the code under test, so a consumer that buffers still holds
 * its whole body after the baseline.
 */
export async function warmHttpTransport(bytes = 64 * MiB): Promise<void> {
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      void pipeline(Readable.from(repeated(bytes)), res).catch(() => undefined);
      return;
    }
    req.resume();
    req.on('end', () => res.writeHead(204).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
  try {
    // A variable, not a literal: the DOM `RequestInit` that apps/web type-checks against has no `duplex`.
    const uploadInit = {
      method: 'POST',
      body: Readable.toWeb(Readable.from(repeated(bytes))) as ReadableStream<Uint8Array>,
      duplex: 'half' as const,
    };
    const uploaded = await fetch(url, uploadInit);
    await uploaded.arrayBuffer();
    const downloaded = await fetch(url);
    if (downloaded.body !== null) for await (const chunk of downloaded.body) void chunk;
    await new Promise<void>((resolve, reject) => {
      const upload = request(url, { method: 'PUT' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      upload.on('error', reject);
      pipeline(Readable.from(repeated(bytes)), upload).catch(reject);
    });
    await new Promise<void>((resolve, reject) => {
      request(url, (res) => {
        res.resume();
        res.on('end', resolve);
      })
        .on('error', reject)
        .end();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
