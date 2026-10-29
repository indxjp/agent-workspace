/**
 * `walkFiles` against a real {@link ObjectStore} — the local-filesystem one, through
 * `@agent-workspace/core/storage` — the same choice `apps/web/server/files/handlers.test.ts` makes, for
 * the same reason: this suite exercises the code path production will use, not a hand-rolled fake.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryCatalog } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  createLocalFilesystemObjectStoreProvider,
  UnsafeObjectKeyError,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';

import { createStorageService } from '../storage/service';
import { createSkillRowsWorld } from './rows-fixture';
import {
  ensureSkillRows,
  skillFiles,
  skillWriter,
  walkFiles,
  type SkillRows,
  type SkillRowsWriter,
  type SkillWriter,
} from './tree';

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
  it('walks a folder with more than one listing page of files', async () => {
    const memory = createInMemoryObjectStoreProvider().forWorkspace(WORKSPACE_ID);
    for (let n = 0; n <= 1000; n += 1) {
      const name = String(n).padStart(4, '0');
      await memory.write(`skills/demo/many/${name}.txt`, utf8('x'), { contentType: null });
    }
    const found = await walkFiles(memory, 'skills/demo');
    expect(found).toHaveLength(1001);
    expect(found.at(-1)).toEqual({
      key: 'skills/demo/many/1000.txt',
      relativePath: 'many/1000.txt',
      sizeBytes: 1,
    });
  });

  it('orders files code unit by code unit, a nested file after its same-named sibling', async () => {
    for (const name of ['a/b.txt', 'a.txt', 'a-b.txt', 'B.txt']) {
      await store.write(`skills/demo/${name}`, utf8(name), { contentType: null });
    }
    const found = await walkFiles(store, 'skills/demo');
    expect(found.map((file) => file.relativePath)).toEqual([
      'B.txt',
      'a-b.txt',
      'a.txt',
      'a/b.txt',
    ]);
  });

  it('returns nothing for a prefix with nothing under it', async () => {
    expect(await walkFiles(store, 'skills/nope')).toEqual([]);
  });

  it('finds a single file directly under the prefix', async () => {
    await store.write('skills/demo/SKILL.md', utf8('# demo\n'), { contentType: null });
    const found = await walkFiles(store, 'skills/demo');
    expect(found).toEqual([
      { key: 'skills/demo/SKILL.md', relativePath: 'SKILL.md', sizeBytes: 7 },
    ]);
  });

  it('recurses into nested folders, arbitrarily deep', async () => {
    await store.write('skills/demo/SKILL.md', utf8('a'), { contentType: null });
    await store.write('skills/demo/scripts/run.sh', utf8('b'), { contentType: null });
    await store.write('skills/demo/scripts/lib/helper.sh', utf8('c'), { contentType: null });
    await store.write('skills/demo/notes/todo.txt', utf8('d'), { contentType: null });

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
    await store.write('skills/demo/SKILL.md', utf8('# demo'), { contentType: null });
    await store.write('skills/demo/scripts/run.sh', utf8('echo hi'), { contentType: null });
    const found = await walkFiles(store, 'skills/demo');
    expect(found.map((f) => [f.relativePath, f.sizeBytes])).toEqual([
      ['SKILL.md', 6],
      ['scripts/run.sh', 7],
    ]);
  });

  it("does not cross into a sibling skill's directory", async () => {
    await store.write('skills/demo-a/SKILL.md', utf8('a'), { contentType: null });
    await store.write('skills/demo-ab/SKILL.md', utf8('b'), { contentType: null });
    const found = await walkFiles(store, 'skills/demo-a');
    expect(found.map((f) => f.relativePath)).toEqual(['SKILL.md']);
  });

  it('returns a stable, sorted order regardless of write order', async () => {
    await store.write('skills/demo/z.txt', utf8('z'), { contentType: null });
    await store.write('skills/demo/a.txt', utf8('a'), { contentType: null });
    await store.write('skills/demo/m.txt', utf8('m'), { contentType: null });
    const found = await walkFiles(store, 'skills/demo');
    expect(found.map((f) => f.relativePath)).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });
});

describe('skillFiles', () => {
  const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
  const principal = { workspaceId: WORKSPACE_ID, principalId: 'p', userId: null };

  function rowsWorld(): {
    rows: SkillRows;
    save: (path: string, body: Uint8Array) => Promise<void>;
  } {
    const catalog = createInMemoryCatalog().forWorkspace(WORKSPACE_ID);
    const storage = createStorageService({
      catalog: () => Promise.resolve(catalog),
      objects: createInMemoryObjectStore(),
      log: noLog,
    });
    return {
      rows: { storage, workspaceId: WORKSPACE_ID },
      save: async (path, body) => {
        const saved = await storage.save(principal, {
          area: 'skills',
          path,
          maxBytes: MAX_SKILL_REQUEST_BODY_BYTES + 1,
          replace: true,
          body: bytesToStream(body),
        });
        if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      },
    };
  }

  const read = async (files: Awaited<ReturnType<typeof skillFiles>>) =>
    Promise.all(
      files.map(async (file) => [
        file.relativePath,
        new TextDecoder().decode((await file.read()) ?? undefined),
      ]),
    );

  // @story US-STO-08
  it('[US-STO-08][api][sdk] rows win over a leftover prefix and are never merged with it', async () => {
    const { rows, save } = rowsWorld();
    await store.write('skills/demo/SKILL.md', utf8('old'), { contentType: null });
    await store.write('skills/demo/old-only.md', utf8('old'), { contentType: null });
    await save('.skills/demo/SKILL.md', utf8('new'));
    await save('.skills/demo/b/c.md', utf8('c'));

    const files = await skillFiles(store, rows, '.skills/demo', 'skills/demo');

    expect(await read(files)).toEqual([
      ['SKILL.md', 'new'],
      ['b/c.md', 'c'],
    ]);
    expect(files.map((file) => file.sizeBytes)).toEqual([3, 1]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a skill with no rows is read from its prefix, with or without a service', async () => {
    const { rows } = rowsWorld();
    await store.write('skills/demo/SKILL.md', utf8('old'), { contentType: null });

    expect(await read(await skillFiles(store, rows, '.skills/demo', 'skills/demo'))).toEqual([
      ['SKILL.md', 'old'],
    ]);
    expect(await read(await skillFiles(store, undefined, '.skills/demo', 'skills/demo'))).toEqual([
      ['SKILL.md', 'old'],
    ]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a row larger than a skill request may be reads as null', async () => {
    const { rows, save } = rowsWorld();
    await save('.skills/big/SKILL.md', new Uint8Array(MAX_SKILL_REQUEST_BODY_BYTES + 1));

    const [file] = await skillFiles(store, rows, '.skills/big', 'skills/big');

    expect(file?.sizeBytes).toBe(MAX_SKILL_REQUEST_BODY_BYTES + 1);
    expect(await file?.read()).toBeNull();
  });
});

describe('skillWriter', () => {
  const writerWorld = (): { rows: SkillRowsWriter } =>
    createSkillRowsWorld(
      createInMemoryObjectStore(),
      WORKSPACE_ID,
      createInMemoryCatalog().forWorkspace(WORKSPACE_ID),
    );

  const names = async (writer: SkillWriter) => (await writer.files()).map((f) => f.relativePath);

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] put saves a row, replaces it in place, and remove tolerates a missing one', async () => {
    const { rows } = writerWorld();
    const writer = skillWriter(store, rows, 'demo');

    await writer.put('SKILL.md', utf8('one'));
    await writer.put('SKILL.md', utf8('two!'));
    await writer.put('a/b.md', utf8('b'));
    await writer.remove('nope.md');
    await writer.remove('a/b.md');

    const [file, ...rest] = await writer.files();
    expect(rest).toEqual([]);
    expect(file?.relativePath).toBe('SKILL.md');
    expect(new TextDecoder().decode((await file?.read()) ?? undefined)).toBe('two!');
    expect(await walkFiles(store, 'skills/demo')).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a revision writer clears only its own folder', async () => {
    const { rows } = writerWorld();
    const current = skillWriter(store, rows, 'demo');
    const revision = skillWriter(store, rows, 'demo', 1);
    await current.put('SKILL.md', utf8('c'));
    await revision.put('SKILL.md', utf8('r'));

    await revision.clear();

    expect(await names(revision)).toEqual([]);
    expect(await names(current)).toEqual(['SKILL.md']);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] an unsafe path is refused before anything is saved', async () => {
    const { rows } = writerWorld();
    const writer = skillWriter(store, rows, 'demo');

    await expect(writer.put('../x.md', utf8('x'))).rejects.toBeInstanceOf(UnsafeObjectKeyError);
    expect(await names(writer)).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] ensureSkillRows moves a prefix into rows and never replaces a row', async () => {
    const { rows } = writerWorld();
    const writer = skillWriter(store, rows, 'demo');
    await store.write('skills/demo/SKILL.md', utf8('old'), { contentType: null });
    await store.write('skills/demo/s/run.sh', utf8('run'), { contentType: null });
    // A row an earlier, interrupted move or another writer already saved.
    await writer.put('SKILL.md', utf8('new'));

    await ensureSkillRows(store, rows, 'demo');

    expect(await names(writer)).toEqual(['SKILL.md', 's/run.sh']);
    const [first] = await writer.files();
    expect(new TextDecoder().decode((await first?.read()) ?? undefined)).toBe('new');
    expect(await walkFiles(store, 'skills/demo')).toEqual([]);

    await writer.remove('s/run.sh');
    await ensureSkillRows(store, rows, 'demo');
    expect(await names(writer)).toEqual(['SKILL.md']);
  });
});
