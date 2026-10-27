// @story US-STO-06
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { encodeUstarStream, extractUstarStream, type StreamTarEntry } from './transfer.js';

type Node = { path: string; mode: number; content?: Uint8Array };

const MAX_BYTES = 1024 * 1024;

// Each path is a file; its parent directories are added, and a file that is also another entry's
// parent is dropped, so the tree is always valid.
const tree = fc
  .uniqueArray(
    fc.record({
      segments: fc.array(fc.stringMatching(/^[a-z0-9]{1,6}$/u), { minLength: 1, maxLength: 3 }),
      // Owner bits only: the process umask would clear group and other bits on write.
      mode: fc.constantFrom(0o400, 0o500, 0o600, 0o700),
      content: fc.uint8Array({ maxLength: 2048 }),
    }),
    { minLength: 1, maxLength: 8, selector: (file) => file.segments.join('/') },
  )
  .map((files): Node[] => {
    const named = files.map((file) => ({ ...file, path: file.segments.join('/') }));
    const taken = new Set(named.map((file) => file.path));
    const kept = named.filter(
      (file) =>
        !file.segments.slice(0, -1).some((_, depth) => {
          return taken.has(file.segments.slice(0, depth + 1).join('/'));
        }),
    );
    const directories = new Set<string>();
    for (const file of kept) {
      for (let depth = 1; depth < file.segments.length; depth += 1) {
        directories.add(file.segments.slice(0, depth).join('/'));
      }
    }
    return [
      ...[...directories].sort().map((directory) => ({ path: directory, mode: 0o755 })),
      ...kept.map(({ path: filePath, mode, content }) => ({ path: filePath, mode, content })),
    ];
  });

function describeFile(mode: number, content: Uint8Array): string {
  return `${(mode & 0o777).toString(8)}:${Buffer.from(content).toString('hex')}`;
}

async function snapshot(root: string, relative = ''): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = relative === '' ? name : `${relative}/${name}`;
    const stat = await lstat(path.join(root, child));
    if (stat.isDirectory()) {
      result.set(child, 'dir');
      for (const [key, value] of await snapshot(root, child)) result.set(key, value);
    } else {
      result.set(child, describeFile(stat.mode, await readFile(path.join(root, child))));
    }
  }
  return result;
}

function entryOf(node: Node): StreamTarEntry {
  const { content } = node;
  if (content === undefined) return { path: node.path, type: 'directory', mode: node.mode };
  return {
    path: node.path,
    type: 'file',
    mode: node.mode,
    size: content.byteLength,
    open: () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content);
            controller.close();
          },
        }),
      ),
  };
}

describe('streaming ustar codec properties', () => {
  it('[US-STO-06][unit][run] stream round-trip preserves tree and modes', async () => {
    await fc.assert(
      fc.asyncProperty(tree, async (nodes) => {
        const root = await mkdtemp(path.join(tmpdir(), 'aw-stream-prop-'));
        try {
          const archive = encodeUstarStream(nodes.map(entryOf), { maxBytes: MAX_BYTES });
          await extractUstarStream(archive, root, { maxBytes: MAX_BYTES });
          const expected = new Map(
            nodes.map((node) => [
              node.path,
              node.content === undefined ? 'dir' : describeFile(node.mode, node.content),
            ]),
          );
          expect(await snapshot(root)).toEqual(expected);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });
});
