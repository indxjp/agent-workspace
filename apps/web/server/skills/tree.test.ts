/**
 * `walkFiles` against a real {@link ObjectStore} — the local-filesystem one, through
 * `object-store-bridge.ts` — the same choice `apps/web/server/files/handlers.test.ts` makes, for
 * the same reason: this suite exercises the code path production will use, not a hand-rolled fake.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalFilesystemObjectStoreProvider, type ObjectStore } from './object-store-bridge';
import { walkFiles } from './tree';

const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';

let rootDir: string;
let store: ObjectStore;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-tree-'));
  store = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('walkFiles', () => {
  it('returns nothing for a prefix with nothing under it', async () => {
    expect(await walkFiles(store, 'skills/nope')).toEqual([]);
  });

  it('finds a single file directly under the prefix', async () => {
    await store.put('skills/demo/SKILL.md', { body: utf8('# demo\n'), contentType: null });
    const found = await walkFiles(store, 'skills/demo');
    expect(found).toEqual([
      { key: 'skills/demo/SKILL.md', relativePath: 'SKILL.md', sizeBytes: 7 },
    ]);
  });

  it('recurses into nested folders, arbitrarily deep', async () => {
    await store.put('skills/demo/SKILL.md', { body: utf8('a'), contentType: null });
    await store.put('skills/demo/scripts/run.sh', { body: utf8('b'), contentType: null });
    await store.put('skills/demo/scripts/lib/helper.sh', { body: utf8('c'), contentType: null });
    await store.put('skills/demo/notes/todo.txt', { body: utf8('d'), contentType: null });

    const found = await walkFiles(store, 'skills/demo');
    expect(found.map((f) => f.relativePath)).toEqual([
      'SKILL.md',
      'notes/todo.txt',
      'scripts/lib/helper.sh',
      'scripts/run.sh',
    ]);
    expect(found.map((f) => f.key)).toEqual([
      'skills/demo/SKILL.md',
      'skills/demo/notes/todo.txt',
      'skills/demo/scripts/lib/helper.sh',
      'skills/demo/scripts/run.sh',
    ]);
  });

  it('reports the size of each file straight from the listing', async () => {
    await store.put('skills/demo/SKILL.md', { body: utf8('# demo'), contentType: null });
    await store.put('skills/demo/scripts/run.sh', { body: utf8('echo hi'), contentType: null });
    const found = await walkFiles(store, 'skills/demo');
    expect(found.map((f) => [f.relativePath, f.sizeBytes])).toEqual([
      ['SKILL.md', 6],
      ['scripts/run.sh', 7],
    ]);
  });

  it("does not cross into a sibling skill's directory", async () => {
    await store.put('skills/demo-a/SKILL.md', { body: utf8('a'), contentType: null });
    await store.put('skills/demo-ab/SKILL.md', { body: utf8('b'), contentType: null });
    const found = await walkFiles(store, 'skills/demo-a');
    expect(found.map((f) => f.relativePath)).toEqual(['SKILL.md']);
  });

  it('returns a stable, sorted order regardless of write order', async () => {
    await store.put('skills/demo/z.txt', { body: utf8('z'), contentType: null });
    await store.put('skills/demo/a.txt', { body: utf8('a'), contentType: null });
    await store.put('skills/demo/m.txt', { body: utf8('m'), contentType: null });
    const found = await walkFiles(store, 'skills/demo');
    expect(found.map((f) => f.relativePath)).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });
});
