import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import {
  createFolderObjectStore,
  type FolderSkipCounts,
  type FolderStoreOptions,
} from './folder-store.js';
import { type ObjectStore } from './object-store.js';

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The per-test folders and skip reports, reset before each test by `useFolderFixture`. */
interface FolderFixture {
  base: string;
  root: string;
  outside: string;
  skipped: FolderSkipCounts[];
  /** A store over `root` that records each skip report in `skipped`. */
  readonly openStore: (options?: FolderStoreOptions) => ObjectStore;
}

/**
 * Registers the shared `beforeEach`/`afterEach`: a fresh temp `base` holding `root` (with
 * `reports/a.txt` and `reports/2026/b.csv`) and `outside` (with `secret.txt`), removed after each test.
 */
export function useFolderFixture(): FolderFixture {
  const fixture: FolderFixture = {
    base: '',
    root: '',
    outside: '',
    skipped: [],
    openStore: (options = {}) =>
      createFolderObjectStore(fixture.root, {
        onSkipped: (counts) => fixture.skipped.push(counts),
        ...options,
      }),
  };

  beforeEach(async () => {
    fixture.base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-folder-')));
    fixture.root = path.join(fixture.base, 'root');
    fixture.outside = path.join(fixture.base, 'outside');
    fixture.skipped = [];
    await mkdir(path.join(fixture.root, 'reports', '2026'), { recursive: true });
    await mkdir(fixture.outside);
    await writeFile(path.join(fixture.root, 'reports', 'a.txt'), 'alpha');
    await writeFile(path.join(fixture.root, 'reports', '2026', 'b.csv'), 'bravo');
    await writeFile(path.join(fixture.outside, 'secret.txt'), 'outside-secret');
  });

  afterEach(async () => {
    await rm(fixture.base, { recursive: true, force: true });
  });

  return fixture;
}
