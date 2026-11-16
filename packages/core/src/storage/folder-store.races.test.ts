// @story US-STO-12
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { keysOf, textAt } from './contract.js';
import { useFolderFixture, utf8 } from './folder-store.fixture.test-support.js';
import { FolderPathError } from './folder-store.js';

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
  const fx = useFolderFixture();
  const { openStore } = fx;

  /** `root/d` holds `f.txt` ('in'); another thread swaps it with a link to `outside` until stopped. */
  async function toggleFolder(): Promise<{
    readonly swaps: () => number;
    readonly stop: () => Promise<void>;
  }> {
    await mkdir(path.join(fx.root, 'd'));
    await writeFile(path.join(fx.root, 'd', 'f.txt'), 'in');
    await writeFile(path.join(fx.outside, 'f.txt'), 'outside');
    await symlink(fx.outside, path.join(fx.root, 'd-link'));
    const worker = await startWorker(TOGGLE_FOLDER, { root: fx.root });
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
    const worker = await startWorker(dies, { root: fx.root });
    expect(await worker.exited).toBe(1);

    await expect(worker.stop()).rejects.toMatchObject({ cause: { code: 'ENOTEMPTY' } });
  });

  it('[US-STO-12][unit][sdk] a folder another thread keeps swapping for an outside link never leaks a read', async () => {
    const store = openStore();
    const leaks: string[] = [];
    await race(async () => {
      if ((await textAt(store, 'd/f.txt')) === 'outside') leaks.push('read');
      if ((await store.head('d/f.txt'))?.sizeBytes === 7) leaks.push('head');
    });

    expect(leaks).toEqual([]);
  });

  it('[US-STO-12][unit][sdk] a folder another thread keeps swapping for an outside link never leaks a name or size', async () => {
    const store = openStore();
    const leaks: string[] = [];
    await race(async () => {
      const entries = [
        ...(await store.listPage('d')).entries,
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

    expect((await readdir(fx.outside)).sort()).toEqual(['f.txt', 'secret.txt']);
    const everywhere = await readdir(fx.base, { recursive: true });
    expect(everywhere.filter((name) => name.includes('.%aw-write-'))).toEqual([]);
  });

  /** Moves `root/reports` to `base/moved` and puts a link to `outside` in its place. */
  async function swapReports(): Promise<void> {
    await rename(path.join(fx.root, 'reports'), path.join(fx.base, 'moved'));
    await symlink(fx.outside, path.join(fx.root, 'reports'));
  }

  async function restoreReports(): Promise<void> {
    await rm(path.join(fx.root, 'reports'));
    await rename(path.join(fx.base, 'moved'), path.join(fx.root, 'reports'));
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
      expect(await readdir(fx.outside)).toEqual(['secret.txt']);
      expect((await readdir(path.join(fx.base, 'moved'))).sort()).toEqual(['2026', 'a.txt']);
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
      expect(await readdir(fx.outside)).toEqual(['secret.txt']);
      expect((await readdir(path.join(fx.base, 'moved'))).sort()).toEqual(['2026', 'a.txt']);
      await restoreReports();
    }
  });

  it('[US-STO-12][unit][sdk] a delete whose folder is moved out and swapped for an outside link after the check is refused and removes nothing', async () => {
    await writeFile(path.join(fx.outside, 'a.txt'), 'outside-copy');
    let swapped = false;
    const store = openStore({
      beforeDelete: async () => {
        swapped = true;
        await swapReports();
      },
    });

    await expect(store.delete('reports/a.txt')).rejects.toBeInstanceOf(FolderPathError);
    expect(swapped).toBe(true);
    expect(await readFile(path.join(fx.outside, 'a.txt'), 'utf8')).toBe('outside-copy');
    expect(await readFile(path.join(fx.base, 'moved', 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('[US-STO-12][unit][sdk] a listing whose middle folder is swapped for an outside link lists no outside name', async () => {
    await mkdir(path.join(fx.outside, '2026'));
    await writeFile(path.join(fx.outside, '2026', 'leak.csv'), 'outside-leak');
    // Swapped before the folder is opened: the open goes through the link, so what it opened decides.
    let opened = false;
    const beforeOpen = openStore({
      beforeOpen: async () => {
        if (opened) return;
        opened = true;
        await swapReports();
      },
    });
    expect(await keysOf(beforeOpen, 'reports/2026', true)).toEqual([]);
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
    expect(await keysOf(beforeReaddir, 'reports/2026', true)).toEqual(['reports/2026/b.csv']);
    expect(read).toBe(true);
  });

  it('[US-STO-12][unit][sdk] a write whose middle folder is moved out after the check stages only in that folder, and is refused', async () => {
    let landed: { readonly outside: string[]; readonly moved: string[] } | undefined;
    const store = openStore({
      beforeStage: swapReports,
      afterStage: async () => {
        landed = {
          outside: await readdir(fx.outside, { recursive: true }),
          moved: await readdir(path.join(fx.base, 'moved', '2026')),
        };
      },
    });

    await expect(store.write('reports/2026/w.txt', utf8('PWN'), {})).rejects.toBeInstanceOf(
      FolderPathError,
    );
    expect(landed?.outside).toEqual(['secret.txt']);
    expect(landed?.moved.filter((name) => name.startsWith('.%aw-write-'))).toHaveLength(1);
    expect(await readdir(fx.outside, { recursive: true })).toEqual(['secret.txt']);
    expect(await readdir(path.join(fx.base, 'moved', '2026'))).toEqual(['b.csv']);
  });
});
