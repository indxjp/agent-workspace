import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatedBody, MiB, peakRssGrowth } from '../../../tests/load/flat-memory.js';
import {
  encodeUstarStream,
  extractUstarStream,
  RUN_FILES_MAX_BYTES,
  type StreamTarEntry,
} from './transfer.js';

const RSS_BOUND = 64 * MiB;

const FILES = 4;

const FILE_BYTES = RUN_FILES_MAX_BYTES / FILES;

async function sha256OfFile(file: string): Promise<{ bytes: number; digest: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { bytes, digest: hash.digest('hex') };
}

describe('bounded streaming memory', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-stream-refuse-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    '[US-STO-06][unit][run] a 128 MiB archive round-trips with flat memory',
    { timeout: 120_000 },
    async () => {
      // One small round trip first, so the file and stream machinery is loaded before the baseline.
      const warm = generatedBody(MiB);
      await extractUstarStream(
        encodeUstarStream(
          [
            {
              path: 'warm.bin',
              type: 'file',
              mode: 0o644,
              size: MiB,
              open: () => Promise.resolve(warm.body),
            },
          ],
          { maxBytes: MiB },
        ),
        path.join(root, 'warm'),
        { maxBytes: MiB },
      );

      const digests: Promise<string>[] = [];
      const entries: StreamTarEntry[] = Array.from({ length: FILES }, (_, index) => ({
        path: `file-${String(index)}.bin`,
        type: 'file',
        mode: 0o644,
        size: FILE_BYTES,
        open: () => {
          const { body, sha256 } = generatedBody(FILE_BYTES);
          digests.push(sha256);
          return Promise.resolve(body);
        },
      }));

      let sent = 0;
      const target = path.join(root, 'out');
      const growth = await peakRssGrowth(async (sample) => {
        const archive = encodeUstarStream(entries, { maxBytes: RUN_FILES_MAX_BYTES }).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              const before = sent;
              sent += chunk.byteLength;
              // Collect at least every 4 MiB so uncollected chunk garbage is not counted.
              if (Math.floor(sent / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
              controller.enqueue(chunk);
            },
          }),
        );
        const written = await extractUstarStream(archive, target, {
          maxBytes: RUN_FILES_MAX_BYTES,
        });
        expect(written).toHaveLength(FILES);
      });

      expect(growth).toBeLessThan(RSS_BOUND);
      const expected = await Promise.all(digests);
      for (let index = 0; index < FILES; index += 1) {
        const actual = await sha256OfFile(path.join(target, `file-${String(index)}.bin`));
        expect(actual.bytes).toBe(FILE_BYTES);
        expect(actual.digest).toBe(expected[index]);
      }
    },
  );
});
