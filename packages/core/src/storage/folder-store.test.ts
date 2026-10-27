// @story US-STO-12
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFolderObjectStore,
  FolderPathError,
  FolderStoreError,
  type FolderSkipCounts,
  type FolderStoreOptions,
} from './folder-store.js';
import { UnsafeObjectKeyError } from './key-safety.js';
import type { ObjectStoreV2 } from './object-store.js';
import { streamToBytes } from './streams.js';

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Each race runs this many rounds, or for this long, whichever comes first. */
const RACE_ROUNDS = 2000;
const RACE_MS = 1200;
/** A race in which the other thread swapped the folder fewer times than this proved nothing. */
const MIN_SWAPS = 20;

/** The shared `Int32Array` slots between a test and its worker. */
const STOP = 0;
const SWAPS = 1;

/**
 * Runs in a worker thread: swaps `<root>/d` between the real folder and the link `<root>/d-link` as
 * fast as `rename` allows, until the shared stop flag is set, counting each time `d` was the link.
 * `d-real` holds the folder while `d` is the link. A write may create a plain `d` while it is briefly
 * absent, and may write into it while it is being cleared; every step is tried again on the next
 * turn rather than ending the worker.
 */
const TOGGLE_FOLDER = `
const { lstatSync, renameSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { workerData } = require('node:worker_threads');
const shared = new Int32Array(workerData.shared);
const d = join(workerData.root, 'd');
const real = join(workerData.root, 'd-real');
const link = join(workerData.root, 'd-link');
const attempt = (step) => {
  try {
    step();
    return true;
  } catch {
    return false;
  }
};
while (Atomics.load(shared, ${STOP}) === 0) {
  if (attempt(() => renameSync(d, real)) && attempt(() => renameSync(link, d))) {
    Atomics.add(shared, ${SWAPS}, 1);
    attempt(() => renameSync(d, link));
  }
  if (!attempt(() => renameSync(real, d))) {
    // A plain folder the store made in the gap; never the link, whose removal would end the swap.
    let plain = false;
    attempt(() => {
      plain = lstatSync(d).isDirectory();
    });
    if (plain) attempt(() => rmSync(d, { recursive: true, force: true }));
    attempt(() => renameSync(real, d));
  }
}
`;

/**
 * A worker running `source` with `workerData` plus a shared `Int32Array` buffer. `exited` and the
 * error listener exist from the spawn, so a worker that dies early is reported, never awaited
 * forever; `stop()` sets the stop flag and resolves once it exited with code 0.
 */
async function startWorker(
  source: string,
  workerData: Record<string, unknown>,
): Promise<{
  readonly shared: Int32Array;
  readonly exited: Promise<number>;
  readonly stop: () => Promise<void>;
}> {
  const buffer = new SharedArrayBuffer(8);
  const worker = new Worker(source, { eval: true, workerData: { ...workerData, shared: buffer } });
  const errors: unknown[] = [];
  worker.on('error', (error) => errors.push(error));
  const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
  await Promise.race([new Promise((resolve) => worker.once('online', resolve)), exited]);
  const shared = new Int32Array(buffer);
  return {
    shared,
    exited,
    stop: async () => {
      Atomics.store(shared, STOP, 1);
      const code = await exited;
      if (errors.length > 0) throw new Error('The worker failed.', { cause: errors[0] });
      if (code !== 0) throw new Error(`The worker exited with code ${code}.`);
    },
  };
}

describe('folder store', () => {
  let base: string;
  let root: string;
  let outside: string;
  let skipped: FolderSkipCounts[];

  const openStore = (options: FolderStoreOptions = {}): ObjectStoreV2 =>
    createFolderObjectStore(root, { onSkipped: (counts) => skipped.push(counts), ...options });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-folder-')));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    skipped = [];
    await mkdir(path.join(root, 'reports', '2026'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, 'reports', 'a.txt'), 'alpha');
    await writeFile(path.join(root, 'reports', '2026', 'b.csv'), 'bravo');
    await writeFile(path.join(outside, 'secret.txt'), 'outside-secret');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('[US-STO-12][unit][sdk] a key is the file at that path, typed by its name', async () => {
    const store = openStore();
    expect(text((await store.get('reports/a.txt'))?.body)).toBe('alpha');
    expect(await store.head('reports/2026/b.csv')).toMatchObject({
      sizeBytes: 5,
      contentType: 'text/csv',
    });
    await writeFile(path.join(root, 'reports', 'blob.unknownext'), '?');
    expect((await store.head('reports/blob.unknownext'))?.contentType).toBe(
      'application/octet-stream',
    );
    expect(await store.head('reports')).toBeNull();
    expect(await store.read('reports/missing.txt')).toBeNull();
    const ranged = await store.read('reports/a.txt', { range: { start: 1, end: 2 } });
    expect(text(await streamToBytes(ranged!.body))).toBe('lp');
  });

  it('[US-STO-12][unit][sdk] a file symlink that leaves the folder is never read or listed', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'reports', 'leak.txt'));
    const store = openStore();

    expect(await store.read('reports/leak.txt')).toBeNull();
    expect(await store.head('reports/leak.txt')).toBeNull();
    expect(await store.get('reports/leak.txt')).toBeNull();
    const keys = [
      ...(await store.list('reports')),
      ...(await store.listPrefix('reports')),
      ...(await store.listPage('reports', { recursive: true })).entries,
    ].map((entry) => entry.key);
    expect(keys).not.toContain('reports/leak.txt');
    expect(keys).toContain('reports/a.txt');
    expect(skipped.every((counts) => counts.links === 1 && counts.unreadable === 0)).toBe(true);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('[US-STO-12][unit][sdk] a directory symlink that leaves the folder is not entered, listed or written through', async () => {
    await symlink(outside, path.join(root, 'linked'));
    const store = openStore();

    expect(await store.read('linked/secret.txt')).toBeNull();
    expect(await store.head('linked/secret.txt')).toBeNull();
    expect((await store.list('')).map((entry) => entry.key)).toEqual(['reports']);
    expect(await store.list('linked')).toEqual([]);
    expect(await store.listPrefix('linked')).toEqual([]);
    expect(skipped).toContainEqual({ links: 1, unreadable: 0 });
    // Through the link as a middle component: only what was opened decides, not the path.
    await mkdir(path.join(outside, 'inner'));
    await writeFile(path.join(outside, 'inner', 'deep.txt'), 'outside-deep');
    expect(await store.list('linked/inner')).toEqual([]);
    expect(await store.listPrefix('linked/inner')).toEqual([]);
    expect((await store.listPage('linked/inner', { recursive: true })).entries).toEqual([]);
    expect(await store.get('linked/inner/deep.txt')).toBeNull();

    await expect(store.write('linked/new.txt', utf8('x'), {})).rejects.toBeInstanceOf(
      FolderPathError,
    );
    await expect(store.put('linked/deeper/new.txt', { body: utf8('x') })).rejects.toBeInstanceOf(
      FolderPathError,
    );
    await expect(store.delete('linked/secret.txt')).resolves.toBeUndefined();
    expect((await readdir(outside)).sort()).toEqual(['inner', 'secret.txt']);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside-secret');
  });

  it('[US-STO-12][unit][sdk] a file symlink is refused even when it stays inside the folder, so reads and listings agree', async () => {
    await symlink(path.join(root, 'reports', 'a.txt'), path.join(root, 'alias.txt'));
    const store = openStore();

    expect(await store.get('alias.txt')).toBeNull();
    expect(await store.read('alias.txt')).toBeNull();
    expect(await store.head('alias.txt')).toBeNull();
    expect((await store.list('')).map((entry) => entry.key)).toEqual(['reports']);
    expect((await store.listPrefix('alias.txt')).map((entry) => entry.key)).toEqual([]);
    expect(skipped).toEqual([{ links: 1, unreadable: 0 }]);
  });

  it('[US-STO-12][unit][sdk] a directory symlink inside the folder is not descended into when listing', async () => {
    await symlink(path.join(root, 'reports'), path.join(root, 'again'));
    const store = openStore();

    expect((await store.list('')).map((entry) => entry.key)).toEqual(['reports']);
    expect((await store.listPrefix('')).map((entry) => entry.key)).toEqual([
      'reports/2026/b.csv',
      'reports/a.txt',
    ]);
  });

  it('[US-STO-12][unit][sdk] an unsafe key is refused by every member and never decoded', async () => {
    const store = openStore();
    const unsafe = ['..', 'a/../b', '%2e%2e/x', '/etc/passwd', 'a\\b', 'a\0b', 'a//b', './a'];
    for (const key of unsafe) {
      await expect(store.read(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.head(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.get(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.write(key, utf8('x'), {})).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.delete(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.listPage(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
    }
    expect(await readdir(base)).toEqual(['outside', 'root']);
  });

  it('[US-STO-12][unit][sdk] a directory swapped for a symlink between the check and the open serves nothing', async () => {
    await writeFile(path.join(outside, 'a.txt'), 'outside-copy');
    let swapped = false;
    const store = openStore({
      beforeOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(path.join(root, 'reports'), path.join(base, 'moved'));
        await symlink(outside, path.join(root, 'reports'));
      },
    });

    expect(await store.read('reports/a.txt')).toBeNull();
    expect(await store.head('reports/a.txt')).toBeNull();
    expect(swapped).toBe(true);
  });

  it('[US-STO-12][unit][sdk] a named pipe is not opened for reading, so it cannot block a worker thread', async () => {
    const pipe = path.join(root, 'reports', 'pipe');
    execFileSync('mkfifo', [pipe]);
    const store = openStore();
    const within = <T>(work: Promise<T>): Promise<T | 'timed out'> =>
      Promise.race([work, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), 1000))]);

    try {
      // Four heads would occupy all four libuv threads if an open blocked; the readFile needs one.
      const heads = Promise.all([1, 2, 3, 4].map(() => store.head('reports/pipe')));
      const unrelated = readFile(path.join(root, 'reports', 'a.txt'), 'utf8');
      expect(await within(heads)).toEqual([null, null, null, null]);
      expect(await within(unrelated)).toBe('alpha');
      expect(await within(store.read('reports/pipe'))).toBeNull();
    } finally {
      // A blocked reader's open returns once a writer opens the pipe; without one it never would.
      try {
        closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // No reader is blocked: the pipe has nobody to release.
      }
    }
  });

  it('[US-STO-12][unit][sdk] a write is atomic: no temp file is listed and a failed body keeps the old file', async () => {
    const store = openStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(utf8('new-'));
        await gate;
        controller.enqueue(utf8('bytes'));
        controller.close();
      },
    });
    const pending = store.write('reports/slow.txt', slow, {});
    for (let attempts = 0; attempts < 200; attempts += 1) {
      const names = await readdir(path.join(root, 'reports'));
      if (names.some((name) => name.startsWith('.%aw-write-'))) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await readdir(path.join(root, 'reports'))).some((n) => n.startsWith('.%'))).toBe(true);
    expect((await store.list('reports')).map((entry) => entry.key)).toEqual([
      'reports/2026',
      'reports/a.txt',
    ]);
    expect(await store.head('reports/slow.txt')).toBeNull();
    release?.();
    const meta = await pending;
    expect(meta.sizeBytes).toBe(9);
    expect(text((await store.get('reports/slow.txt'))?.body)).toBe('new-bytes');

    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(utf8('partial'));
        controller.error(new Error('source broke'));
      },
    });
    await expect(store.write('reports/a.txt', failing, {})).rejects.toThrow('source broke');
    expect(text((await store.get('reports/a.txt'))?.body)).toBe('alpha');
    expect((await readdir(path.join(root, 'reports'))).sort()).toEqual([
      '2026',
      'a.txt',
      'slow.txt',
    ]);
  });

  it('[US-STO-12][unit][sdk] a write replaces a symlink at the target instead of writing through it', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'target.txt'));
    const store = openStore();

    await store.write('target.txt', utf8('mine'), {});
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside-secret');
    expect((await lstat(path.join(root, 'target.txt'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(root, 'target.txt'), 'utf8')).toBe('mine');
  });

  it('[US-STO-12][unit][sdk] a write creates missing folders, copy and delete work on plain files', async () => {
    const store = openStore();
    await store.put('new/deep/note.md', {
      body: utf8('hello'),
      contentType: 'application/x-ignored',
    });
    expect((await store.head('new/deep/note.md'))?.contentType).toBe('text/markdown');
    await store.copyObject('new/deep/note.md', 'copy.md');
    expect(text((await store.get('copy.md'))?.body)).toBe('hello');
    await store.delete('copy.md');
    await store.delete('copy.md');
    expect(await store.head('copy.md')).toBeNull();
    await store.delete('new');
    expect(await store.head('new/deep/note.md')).not.toBeNull();
    await store.copyObject('never.md', 'dest.md');
    expect(await store.head('dest.md')).toBeNull();
  });

  it('[US-STO-12][unit][sdk] a file the process cannot read is skipped and counted, not fatal', async () => {
    const locked = path.join(root, 'reports', 'locked.txt');
    await writeFile(locked, 'nope');
    await chmod(locked, 0o000);
    const store = openStore();

    const keys = (await store.list('reports')).map((entry) => entry.key);
    expect(keys).toEqual(['reports/2026', 'reports/a.txt']);
    expect(skipped).toEqual([{ links: 0, unreadable: 1 }]);
  });

  it('[US-STO-12][unit][sdk] folder names with a space list their files, and paging visits each entry once', async () => {
    await mkdir(path.join(root, 'Q3 reports'), { recursive: true });
    await writeFile(path.join(root, 'Q3 reports', 'n 1.txt'), 'one');
    await writeFile(path.join(root, 'Q3 reports', 'n 2.txt'), 'two');
    const store = openStore();

    expect((await store.list('')).map((entry) => entry.key)).toEqual(['Q3 reports', 'reports']);
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listPage('Q3 reports', {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      keys.push(...page.entries.map((entry) => entry.key));
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(keys).toEqual(['Q3 reports/n 1.txt', 'Q3 reports/n 2.txt']);
  });

  it('[US-STO-12][unit][sdk] hidden files are listed like any other, and names the key guard refuses are not', async () => {
    await writeFile(path.join(root, '.hidden'), 'h');
    await writeFile(path.join(root, '50%.txt'), 'foreign');
    const store = openStore();

    expect((await store.list('')).map((entry) => entry.key)).toEqual(['.hidden', 'reports']);
  });

  /** `root/d` holds `f.txt` ('in'); another thread swaps it with a link to `outside` until stopped. */
  async function toggleFolder(): Promise<{
    readonly swaps: () => number;
    readonly stop: () => Promise<void>;
  }> {
    await mkdir(path.join(root, 'd'));
    await writeFile(path.join(root, 'd', 'f.txt'), 'in');
    await writeFile(path.join(outside, 'f.txt'), 'outside');
    await symlink(outside, path.join(root, 'd-link'));
    const worker = await startWorker(TOGGLE_FOLDER, { root });
    return { swaps: () => Atomics.load(worker.shared, SWAPS), stop: worker.stop };
  }

  /**
   * Runs `round` `RACE_ROUNDS` times or for `RACE_MS`, whichever comes first, then stops the swap:
   * the worker must have exited cleanly and swapped the folder at least `MIN_SWAPS` times.
   */
  async function race(round: () => Promise<void>): Promise<void> {
    const toggler = await toggleFolder();
    try {
      const deadline = Date.now() + RACE_MS;
      for (let rounds = 0; rounds < RACE_ROUNDS && Date.now() < deadline; rounds += 1)
        await round();
    } finally {
      await toggler.stop();
    }
    expect(toggler.swaps()).toBeGreaterThanOrEqual(MIN_SWAPS);
  }

  it('[US-STO-12][unit][sdk] the race harness reports a worker that died, instead of waiting for it forever', async () => {
    // The old toggler's death: the store writes into `d` while it is being cleared, so the final
    // `rmdir` of `rmSync` fails `ENOTEMPTY` and nothing caught it.
    await openStore().write('d/w.txt', utf8('written meanwhile'), {});
    const dies = `
      const { rmdirSync } = require('node:fs');
      const { join } = require('node:path');
      const { workerData } = require('node:worker_threads');
      rmdirSync(join(workerData.root, 'd'));
    `;
    const worker = await startWorker(dies, { root });
    expect(await worker.exited).toBe(1);

    await expect(worker.stop()).rejects.toMatchObject({ cause: { code: 'ENOTEMPTY' } });
  });

  it('[US-STO-12][unit][sdk] a folder another thread keeps swapping for an outside link never leaks a read', async () => {
    const store = openStore();
    const leaks: string[] = [];
    await race(async () => {
      if (text((await store.get('d/f.txt'))?.body) === 'outside') leaks.push('get');
      if ((await store.head('d/f.txt'))?.sizeBytes === 7) leaks.push('head');
    });

    expect(leaks).toEqual([]);
  });

  it('[US-STO-12][unit][sdk] a folder another thread keeps swapping for an outside link never leaks a name or size', async () => {
    const store = openStore();
    const leaks: string[] = [];
    await race(async () => {
      const entries = [
        ...(await store.listPrefix('d')),
        ...(await store.list('d')),
        ...(await store.listPage('d', { recursive: true })).entries,
      ];
      for (const entry of entries) {
        if (entry.key !== 'd/f.txt' || (entry.kind === 'file' && entry.sizeBytes !== 2)) {
          leaks.push(entry.key);
        }
      }
    });

    expect(leaks).toEqual([]);
  });

  it('[US-STO-12][unit][sdk] a folder another thread keeps swapping for an outside link never receives a write or a temp file', async () => {
    const store = openStore();
    await race(async () => {
      await store.write('d/w.txt', utf8('PWN'), {}).catch(() => null);
    });

    expect((await readdir(outside)).sort()).toEqual(['f.txt', 'secret.txt']);
    const everywhere = await readdir(base, { recursive: true });
    expect(everywhere.filter((name) => name.includes('.%aw-write-'))).toEqual([]);
  });

  /** Moves `root/reports` to `base/moved` and puts a link to `outside` in its place. */
  async function swapReports(): Promise<void> {
    await rename(path.join(root, 'reports'), path.join(base, 'moved'));
    await symlink(outside, path.join(root, 'reports'));
  }

  async function restoreReports(): Promise<void> {
    await rm(path.join(root, 'reports'));
    await rename(path.join(base, 'moved'), path.join(root, 'reports'));
  }

  it('[US-STO-12][unit][sdk] a write whose folder is swapped for an outside link after the check is refused and leaves no temp file', async () => {
    for (const writeOptions of [{}, { ifNoneMatch: '*' as const }]) {
      let swapped = false;
      const store = openStore({
        beforeStage: async () => {
          swapped = true;
          await swapReports();
        },
      });

      await expect(store.write('reports/w.txt', utf8('PWN'), writeOptions)).rejects.toBeInstanceOf(
        FolderPathError,
      );
      expect(swapped).toBe(true);
      expect(await readdir(outside)).toEqual(['secret.txt']);
      expect((await readdir(path.join(base, 'moved'))).sort()).toEqual(['2026', 'a.txt']);
      await restoreReports();
    }
  });

  it('[US-STO-12][unit][sdk] a write whose folder is moved out after staging is refused before the rename or link', async () => {
    for (const writeOptions of [{}, { ifNoneMatch: '*' as const }]) {
      let swapped = false;
      const store = openStore({
        beforeCommit: async () => {
          swapped = true;
          await swapReports();
        },
      });

      await expect(store.write('reports/w.txt', utf8('PWN'), writeOptions)).rejects.toBeInstanceOf(
        FolderPathError,
      );
      expect(swapped).toBe(true);
      expect(await readdir(outside)).toEqual(['secret.txt']);
      expect((await readdir(path.join(base, 'moved'))).sort()).toEqual(['2026', 'a.txt']);
      await restoreReports();
    }
  });

  it('[US-STO-12][unit][sdk] a delete whose folder is moved out and swapped for an outside link after the check is refused and removes nothing', async () => {
    await writeFile(path.join(outside, 'a.txt'), 'outside-copy');
    let swapped = false;
    const store = openStore({
      beforeDelete: async () => {
        swapped = true;
        await swapReports();
      },
    });

    await expect(store.delete('reports/a.txt')).rejects.toBeInstanceOf(FolderPathError);
    expect(swapped).toBe(true);
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('outside-copy');
    expect(await readFile(path.join(base, 'moved', 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('[US-STO-12][unit][sdk] a listing whose middle folder is swapped for an outside link lists no outside name', async () => {
    await mkdir(path.join(outside, '2026'));
    await writeFile(path.join(outside, '2026', 'leak.csv'), 'outside-leak');
    const keysOf = (entries: readonly { readonly key: string }[]): string[] =>
      entries.map((entry) => entry.key);

    // Swapped before the folder is opened: the open goes through the link, so what it opened decides.
    let opened = false;
    const beforeOpen = openStore({
      beforeOpen: async () => {
        if (opened) return;
        opened = true;
        await swapReports();
      },
    });
    expect(keysOf(await beforeOpen.listPrefix('reports/2026'))).toEqual([]);
    expect(opened).toBe(true);
    await restoreReports();

    // Swapped once the folder is open: its names are read through the descriptor, not the path.
    let read = false;
    const beforeReaddir = openStore({
      beforeReaddir: async () => {
        if (read) return;
        read = true;
        await swapReports();
      },
    });
    expect(keysOf(await beforeReaddir.listPrefix('reports/2026'))).toEqual(['reports/2026/b.csv']);
    expect(read).toBe(true);
  });

  it('[US-STO-12][unit][sdk] a write whose middle folder is moved out after the check stages only in that folder, and is refused', async () => {
    let landed: { readonly outside: string[]; readonly moved: string[] } | undefined;
    const store = openStore({
      beforeStage: swapReports,
      afterStage: async () => {
        landed = {
          outside: await readdir(outside, { recursive: true }),
          moved: await readdir(path.join(base, 'moved', '2026')),
        };
      },
    });

    await expect(store.write('reports/2026/w.txt', utf8('PWN'), {})).rejects.toBeInstanceOf(
      FolderPathError,
    );
    expect(landed?.outside).toEqual(['secret.txt']);
    expect(landed?.moved.filter((name) => name.startsWith('.%aw-write-'))).toHaveLength(1);
    expect(await readdir(outside, { recursive: true })).toEqual(['secret.txt']);
    expect(await readdir(path.join(base, 'moved', '2026'))).toEqual(['b.csv']);
  });

  it('[US-STO-12][unit][sdk] a link as a middle component is never written or deleted through, even to an existing outside folder', async () => {
    await symlink(outside, path.join(root, 'linked'));
    await mkdir(path.join(outside, 'inner'));
    await writeFile(path.join(outside, 'inner', 'deep.txt'), 'outside-deep');
    const store = openStore();

    await expect(store.write('linked/inner/new.txt', utf8('x'), {})).rejects.toBeInstanceOf(
      FolderPathError,
    );
    await store.delete('linked/inner/deep.txt');
    expect(await readdir(path.join(outside, 'inner'))).toEqual(['deep.txt']);
    expect(await readFile(path.join(outside, 'inner', 'deep.txt'), 'utf8')).toBe('outside-deep');
  });

  describe('without /proc/self/fd (the path-check fallback)', () => {
    const openFallback = (): ObjectStoreV2 => openStore({ procFd: false });

    it('[US-STO-12][unit][sdk] an outside file symlink is never read or listed', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'reports', 'leak.txt'));
      const store = openFallback();

      expect(await store.get('reports/leak.txt')).toBeNull();
      expect(await store.head('reports/leak.txt')).toBeNull();
      expect((await store.listPrefix('reports')).map((entry) => entry.key)).toEqual([
        'reports/2026/b.csv',
        'reports/a.txt',
      ]);
      expect(skipped).toEqual([{ links: 1, unreadable: 0 }]);
    });

    it('[US-STO-12][unit][sdk] an outside directory symlink is not entered, listed or written through', async () => {
      await symlink(outside, path.join(root, 'linked'));
      await mkdir(path.join(outside, 'inner'));
      await writeFile(path.join(outside, 'inner', 'deep.txt'), 'outside-deep');
      const store = openFallback();

      expect(await store.get('linked/secret.txt')).toBeNull();
      expect(await store.get('linked/inner/deep.txt')).toBeNull();
      expect(await store.list('linked')).toEqual([]);
      expect(await store.listPrefix('linked/inner')).toEqual([]);
      expect((await store.list('')).map((entry) => entry.key)).toEqual(['reports']);
      for (const key of ['linked/new.txt', 'linked/inner/new.txt', 'linked/deeper/new.txt']) {
        await expect(store.write(key, utf8('x'), {})).rejects.toBeInstanceOf(FolderPathError);
      }
      await store.delete('linked/inner/deep.txt');
      expect((await readdir(outside, { recursive: true })).sort()).toEqual([
        'inner',
        'inner/deep.txt',
        'secret.txt',
      ]);
    });

    it('[US-STO-12][unit][sdk] the `..` key is refused', async () => {
      const store = openFallback();
      for (const key of ['..', '../outside/secret.txt', 'reports/../../outside/secret.txt']) {
        await expect(store.get(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
        await expect(store.write(key, utf8('x'), {})).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      }
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside-secret');
    });
  });

  it('[US-STO-12][unit][sdk] an overwrite keeps the file mode, and a new file is no wider than 0644', async () => {
    const file = path.join(root, 'reports', 'a.txt');
    // World-writable, so a umask of 002 or 022 would narrow it if the store did not restore it.
    await chmod(file, 0o666);
    const store = openStore();

    await store.write('reports/a.txt', utf8('again'), {});
    expect((await stat(file)).mode & 0o777).toBe(0o666);
    expect(await readFile(file, 'utf8')).toBe('again');
    await store.write('reports/new.txt', utf8('n'), {});
    expect((await stat(path.join(root, 'reports', 'new.txt'))).mode & 0o777 & ~0o644).toBe(0);
  });

  it('[US-STO-12][unit][sdk] a filesystem failure names the key and a code, never a host path', async () => {
    await symlink(path.join(root, 'nowhere'), path.join(root, 'dangling'));
    const store = openStore();
    const failed = (work: Promise<unknown>): Promise<unknown> =>
      work.then(
        () => new Error('it succeeded'),
        (error: unknown) => error,
      );

    const errors = [
      // A folder where the file goes: `rename` fails `EISDIR`.
      await failed(store.write('reports/2026', utf8('x'), {})),
      // A file where a folder goes: `ENOTDIR`.
      await failed(store.write('reports/a.txt/x.txt', utf8('x'), {})),
      // A dangling link where a folder goes.
      await failed(store.write('dangling/x.txt', utf8('x'), {})),
    ];
    await chmod(path.join(root, 'reports'), 0o555);
    try {
      // A folder the process may not change: `unlink` fails `EACCES`.
      errors.push(await failed(store.delete('reports/a.txt')));
    } finally {
      await chmod(path.join(root, 'reports'), 0o755);
    }

    expect(errors.map((error) => (error as Error).name)).toEqual([
      'FolderStoreError',
      'FolderStoreError',
      'FolderPathError',
      'FolderStoreError',
    ]);
    expect(errors.map((error) => (error as { code?: unknown }).code)).toEqual([
      'EISDIR',
      'ENOTDIR',
      'storage_connection_endpoint_forbidden',
      'EACCES',
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).message).not.toContain(os.tmpdir());
      expect((error as Error).cause).toBeUndefined();
    }
    expect(errors[0]).toBeInstanceOf(FolderStoreError);
    expect(await readFile(path.join(root, 'reports', 'a.txt'), 'utf8')).toBe('alpha');
  });
});
