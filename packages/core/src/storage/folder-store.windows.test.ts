// @story US-STO-12
/**
 * The folder store on Windows (#1835). The name checks run everywhere, with `windowsNames` forced
 * on; the native cases run only on Windows, in the `CI Windows unit` workflow
 * (`.github/workflows/windows-unit.yml`), since only NTFS mints the aliases they guard against.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keysOf, textAt } from './contract.js';
import { createFolderObjectStore } from './folder-store.js';
import { UnsafeObjectKeyError } from './key-safety.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const onWindows = process.platform === 'win32';

/** Names Win32 reads as another name (a stream, a stripped dot or space) or as a device. */
const WINDOWS_ALIASES = [
  'reports/a.txt:hidden',
  'reports/a.txt::$DATA',
  'reports/a.txt.',
  'reports/a.txt ',
  'NUL',
  'reports/con.txt',
  'reports/Aux',
  'COM1/x.txt',
  'reports/lpt9.log',
  'reports/CONIN$',
  'reports/what?.txt',
  'reports/a*b',
  'reports/<a>',
  'reports/a|b',
  'reports/"q"',
];

describe('folder store on Windows', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-folder-win-')));
    await mkdir(path.join(root, 'reports'));
    await writeFile(path.join(root, 'reports', 'a.txt'), 'alpha');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(WINDOWS_ALIASES)(
    '[US-STO-12][unit][sdk] the name %j is refused by every member where Windows names apply',
    async (key) => {
      const store = createFolderObjectStore(root, { windowsNames: true });

      await expect(store.read(key)).rejects.toMatchObject({ rule: 'windows-name' });
      await expect(store.head(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.write(key, utf8('x'), {})).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.delete(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      await expect(store.listPage(key)).rejects.toBeInstanceOf(UnsafeObjectKeyError);
      expect(await readFile(path.join(root, 'reports', 'a.txt'), 'utf8')).toBe('alpha');
    },
  );

  it('[US-STO-12][unit][sdk] Windows names apply by default on Windows only, and ordinary names are untouched', async () => {
    const store = createFolderObjectStore(root);
    const refused = store.read('reports/a.txt:hidden');
    if (onWindows) await expect(refused).rejects.toBeInstanceOf(UnsafeObjectKeyError);
    else await expect(refused).resolves.toBeNull();

    const strict = createFolderObjectStore(root, { windowsNames: true });
    for (const key of ['reports/console.txt', 'reports/nul-report.txt', 'reports/a.b.c', 'COM10']) {
      await strict.write(key, utf8(key), {});
      expect(await textAt(strict, key)).toBe(key);
    }
  });

  it.runIf(!onWindows)(
    '[US-STO-12][unit][sdk] a name on disk that Windows would read as another name is not listed',
    async () => {
      await writeFile(path.join(root, 'reports', 'trailing.'), 'x');
      await writeFile(path.join(root, 'reports', 'nul'), 'x');
      const store = createFolderObjectStore(root, { windowsNames: true });

      expect(await keysOf(store, 'reports')).toEqual(['reports/a.txt']);
      expect(await keysOf(store, '', true)).toEqual(['reports/a.txt']);
    },
  );

  // Runs everywhere: on Windows `windowsNames` is the default and NTFS is what could mint the
  // alternate data stream; elsewhere the option is forced, so the refusal path is the same one.
  it('[US-STO-12][unit][sdk] on NTFS a stream name writes no alternate data stream and an ordinary write round-trips', async () => {
    const store = createFolderObjectStore(root, onWindows ? {} : { windowsNames: true });

    await expect(store.write('reports/a.txt:hidden', utf8('x'), {})).rejects.toBeInstanceOf(
      UnsafeObjectKeyError,
    );
    await expect(readFile(path.join(root, 'reports', 'a.txt:hidden'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(store.read('reports/a.txt::$DATA')).rejects.toBeInstanceOf(UnsafeObjectKeyError);

    await store.write('reports/new/b.txt', utf8('bravo'), {});
    const etag = (await store.head('reports/new/b.txt'))?.etag ?? '';
    await store.write('reports/new/b.txt', utf8('bravo 2'), { ifMatch: etag });
    expect(await textAt(store, 'reports/new/b.txt')).toBe('bravo 2');
    expect(await keysOf(store, 'reports', true)).toEqual(['reports/a.txt', 'reports/new/b.txt']);
    await store.delete('reports/new/b.txt');
    expect(await readdir(path.join(root, 'reports', 'new'))).toEqual([]);
  });
});
