/**
 * Shared flat-memory harness. Load tests live in `tests/load/*.test.ts`, import this file, and
 * assert how far the process RSS grows while a large body moves. The full 1 GiB runs only with
 * `AW_LOAD_TESTS=1` (one CI step sets it, #1650); otherwise 32 MiB keeps local and PR runs fast.
 * It imports nothing from Vitest, so any test can use it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

/** V8's young generation (new space): the bytes it has committed and the bytes live objects use. */
export type NewSpace = Readonly<{ committed: number; used: number }>;

function newSpace(): NewSpace {
  const space = getHeapSpaceStatistics().find((entry) => entry.space_name === 'new_space');
  return { committed: space?.physical_space_size ?? 0, used: space?.space_used_size ?? 0 };
}

/**
 * The most new-space growth a reading may subtract: the largest new space V8 builds on Node 24,
 * two 64 MiB semi-spaces. V8 reaches it in more than one step, so growth past one 64 MiB step is
 * legitimate: CI run 40764100611 read 116.6 MiB on GCS, and Node 24 commits up to about 123 MiB of
 * it, empty after a full GC with nothing live. Growth past the whole new space cannot be V8's and
 * fails the reading rather than hide anything behind it.
 */
export const NEW_SPACE_CREDIT_BOUND = 128 * MiB;

/**
 * The new-space growth (bytes) one sample subtracts from its RSS reading: only committed pages no
 * live object uses. The forced full GC before each sample promotes every live young object to old
 * space, so new space is empty there; any byte still in use is counted as growth, never credited,
 * so new space cannot hide retention. Growth past {@link NEW_SPACE_CREDIT_BOUND} throws.
 */
export function newSpaceCredit(baseline: NewSpace, now: NewSpace): number {
  const empty = (space: NewSpace): number => Math.max(0, space.committed - space.used);
  const growth = Math.max(0, empty(now) - empty(baseline));
  if (growth > NEW_SPACE_CREDIT_BOUND) {
    throw new Error(
      `flat-memory: new space grew ${(growth / MiB).toFixed(1)} MiB, over the ` +
        `${String(NEW_SPACE_CREDIT_BOUND / MiB)} MiB a reading may subtract`,
    );
  }
  return growth;
}

/**
 * The memory the process holds (bytes): on Linux its anonymous and shared-memory pages, resident or
 * swapped (`RssAnon + RssShmem + VmSwap` in `/proc/self/status`); elsewhere `process.memoryUsage().rss`.
 *
 * Plain RSS falls when the kernel reclaims pages, so under memory pressure a consumer that holds
 * its whole body can read as flat: the full parallel `pnpm test` read 30.8 MiB for the 64 MiB the
 * formData() negative control holds, and the same test under a 150 MiB cgroup `MemoryHigh` read 0
 * while 69 MiB sat in swap. A swapped page is still held, so it is counted. File-backed pages
 * (the node binary and the modules it maps) are left out: the kernel drops them under pressure
 * without swapping, and no consumer holds a body in them.
 */
export function heldMemory(): number {
  if (process.platform !== 'linux') return process.memoryUsage().rss;
  const status = readFileSync('/proc/self/status', 'utf8');
  const kilobytes = (field: string): number => {
    const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(status);
    if (match?.[1] === undefined) throw new Error(`flat-memory: /proc/self/status has no ${field}`);
    return Number(match[1]) * 1024;
  };
  return kilobytes('RssAnon') + kilobytes('RssShmem') + kilobytes('VmSwap');
}

/** A {@link measureRssGrowth} reading: the peak RSS growth and the new-space growth it subtracted. */
export type RssReading = Readonly<{ growth: number; newSpaceGrowth: number }>;

/**
 * Peak RSS growth (bytes) while `work` runs, read as {@link heldMemory} so reclaimed pages still count, and the most new-space growth it subtracted; forces GC before the baseline and before each sample.
 * Call `sample()` inside `work` while the data is still referenced; the trailing sample alone
 * cannot see memory `work` has already released. Sample at least every bound/16 of payload (every
 * 4 MiB for a 64 MiB bound): V8 lets uncollected socket-read buffers reach about 64 MiB of external
 * memory before it collects on its own, and glibc keeps their pages, so sampling every 32 MiB read
 * 67.6 MiB on CI with about 8 MiB really in flight (PR #1747). A forced GC frees only unreachable
 * memory, so retention is still counted.
 *
 * Growth of V8's young generation is not counted. Under a high allocation rate V8 enlarges new
 * space (in steps of up to 64 MiB, to 128 MiB on Node 24), and a full GC empties it but does not give
 * the pages back, so RSS jumped by about 64 MiB at random with nothing retained (PR #1740: up to
 * 104 MiB on S3 and 98 MiB on GCS, 64 MiB of it new space). New space is bounded by V8 whatever the payload, and
 * the forced full GC before every sample promotes anything still live out of it, so retained data
 * (old space, ArrayBuffer backing stores, native buffers, and any byte left live in new space) is
 * still counted. A shrinking new space is not credited.
 */
export async function measureRssGrowth(
  work: (sample: () => void) => Promise<void>,
): Promise<RssReading> {
  collect();
  const baseline = heldMemory();
  const newSpaceBaseline = newSpace();
  let peak = 0;
  let newSpacePeak = 0;
  const sample = (): void => {
    collect();
    const newSpaceGrowth = newSpaceCredit(newSpaceBaseline, newSpace());
    newSpacePeak = Math.max(newSpacePeak, newSpaceGrowth);
    peak = Math.max(peak, heldMemory() - baseline - newSpaceGrowth);
  };
  await work(sample);
  sample();
  return { growth: peak, newSpaceGrowth: newSpacePeak };
}

/** {@link measureRssGrowth}'s peak growth alone. */
export async function peakRssGrowth(work: (sample: () => void) => Promise<void>): Promise<number> {
  return (await measureRssGrowth(work)).growth;
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
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
        res.on('error', reject);
        res.resume();
        res.on('end', resolve);
      });
      upload.on('error', reject);
      pipeline(Readable.from(repeated(bytes)), upload).catch(reject);
    });
    await new Promise<void>((resolve, reject) => {
      request(url, (res) => {
        res.on('error', reject);
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
