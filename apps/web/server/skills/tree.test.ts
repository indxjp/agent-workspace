/** `skillFiles` and `skillWriter` over the real catalog service and the in-memory catalog. */
import { describe, expect, it } from 'vitest';

import { createInMemoryCatalog } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  UnsafeObjectKeyError,
} from '@agent-workspace/core/storage';
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';

import { createStorageService } from '../storage/service';
import { createSkillRowsWorld } from './rows-fixture';
import {
  skillFiles,
  skillWriter,
  type SkillRows,
  type SkillRowsWriter,
  type SkillWriter,
} from './tree';

const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

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
  it('[US-STO-08][api][sdk] reads every row under the folder, with its size', async () => {
    const { rows, save } = rowsWorld();
    await save('.skills/demo/SKILL.md', utf8('new'));
    await save('.skills/demo/b/c.md', utf8('c'));
    await save('.skills/demo-two/SKILL.md', utf8('other'));

    const files = await skillFiles(rows, '.skills/demo');

    expect(await read(files)).toEqual([
      ['SKILL.md', 'new'],
      ['b/c.md', 'c'],
    ]);
    expect(files.map((file) => file.sizeBytes)).toEqual([3, 1]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] orders files code unit by code unit, a nested file after its same-named sibling', async () => {
    const { rows, save } = rowsWorld();
    for (const name of ['a/b.txt', 'a.txt', 'a-b.txt', 'B.txt']) {
      await save(`.skills/demo/${name}`, utf8(name));
    }

    const files = await skillFiles(rows, '.skills/demo');

    expect(files.map((file) => file.relativePath)).toEqual([
      'B.txt',
      'a-b.txt',
      'a.txt',
      'a/b.txt',
    ]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a folder with no rows, or no catalog service, has no files', async () => {
    const { rows } = rowsWorld();

    expect(await skillFiles(rows, '.skills/nope')).toEqual([]);
    expect(await skillFiles(undefined, '.skills/nope')).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a row larger than a skill request may be reads as null', async () => {
    const { rows, save } = rowsWorld();
    await save('.skills/big/SKILL.md', new Uint8Array(MAX_SKILL_REQUEST_BODY_BYTES + 1));

    const [file] = await skillFiles(rows, '.skills/big');

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
    const writer = skillWriter(rows, 'demo');

    await writer.put('SKILL.md', utf8('one'));
    await writer.put('SKILL.md', utf8('two!'));
    await writer.put('a/b.md', utf8('b'));
    await writer.remove('nope.md');
    await writer.remove('a/b.md');

    const [file, ...rest] = await writer.files();
    expect(rest).toEqual([]);
    expect(file?.relativePath).toBe('SKILL.md');
    expect(new TextDecoder().decode((await file?.read()) ?? undefined)).toBe('two!');
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a revision writer clears only its own folder', async () => {
    const { rows } = writerWorld();
    const current = skillWriter(rows, 'demo');
    const revision = skillWriter(rows, 'demo', 1);
    await current.put('SKILL.md', utf8('c'));
    await revision.put('SKILL.md', utf8('r'));

    await revision.clear();

    expect(await names(revision)).toEqual([]);
    expect(await names(current)).toEqual(['SKILL.md']);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] an unsafe path is refused before anything is saved', async () => {
    const { rows } = writerWorld();
    const writer = skillWriter(rows, 'demo');

    await expect(writer.put('../x.md', utf8('x'))).rejects.toBeInstanceOf(UnsafeObjectKeyError);
    expect(await names(writer)).toEqual([]);
  });
});
