/**
 * `handlers.ts` against a real {@link ObjectStore} — the local-filesystem one, through
 * `@agent-workspace/core/storage` — mirroring `apps/web/server/files/handlers.test.ts`'s choice: this
 * suite exercises the same code path production will, not a hand-rolled fake.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportSkill,
  getSkill,
  importSkill,
  listSkills,
  patchSkill,
  requireSkillName,
  type SkillDetail,
} from './handlers';
import type { SkillRowsWriter } from './tree';
import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { listAll } from '@agent-workspace/core/storage/streams';

import { createInMemoryCatalog } from '@agent-workspace/core/db';
import { skillRowFolder } from './keys';
import { createSkillRowsWorld, ROWS_WORKSPACE_ID as WORKSPACE_ID } from './rows-fixture';

let rootDir: string;
let store: ObjectStore;
let world: ReturnType<typeof createSkillRowsWorld>;
let catalog: ReturnType<ReturnType<typeof createInMemoryCatalog>['forWorkspace']>;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-handlers-'));
  store = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
  catalog = createInMemoryCatalog().forWorkspace(WORKSPACE_ID);
  world = createSkillRowsWorld(createInMemoryObjectStore(), WORKSPACE_ID, catalog);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

const MINIMAL_SKILL_MD = '---\nname: demo\ndescription: A demo skill\n---\n\nDo the thing.\n';

async function importMinimal(name = 'demo'): Promise<SkillDetail> {
  const result = await importSkill(
    store,
    {
      name,
      files: [{ path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) }],
    },
    world.rows,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return (result.body as { skill: SkillDetail }).skill;
}

describe('requireSkillName', () => {
  it('accepts a valid slug', () => {
    expect(requireSkillName('demo-skill')).toEqual({ ok: true, name: 'demo-skill' });
  });

  it('404s a name no import could ever produce, rather than 400ing it', () => {
    const result = requireSkillName('Not-A-Slug');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.status).toBe(404);
  });

  it('404s a non-string param defensively', () => {
    const result = requireSkillName(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.status).toBe(404);
  });
});

describe('importSkill', () => {
  it('creates a skill from just a SKILL.md, and describes it back with its parsed frontmatter', async () => {
    const skill = await importMinimal();
    expect(skill).toMatchObject({
      name: 'demo',
      enabled: true,
      description: 'A demo skill',
      fileCount: 1,
    });
    expect(skill.files).toEqual([{ path: 'SKILL.md', sizeBytes: MINIMAL_SKILL_MD.length }]);
  });

  it('imports a directory of supporting files alongside SKILL.md', async () => {
    const result = await importSkill(
      store,
      {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
          { path: 'scripts/run.sh', contentBase64: b64('#!/bin/sh\necho hi\n') },
          { path: 'reference/notes.txt', contentBase64: b64('notes') },
        ],
      },
      world.rows,
    );
    expect(result.status).toBe(201);
    const skill = (result.body as { skill: SkillDetail }).skill;
    expect(skill.fileCount).toBe(3);
    expect(skill.files.map((f) => f.path).sort()).toEqual([
      'SKILL.md',
      'reference/notes.txt',
      'scripts/run.sh',
    ]);
  });

  it('rejects a missing name', async () => {
    const result = await importSkill(
      store,
      {
        files: [{ path: 'SKILL.md', contentBase64: b64('x') }],
      },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('missing_name');
  });

  it('rejects a name that is not a slug', async () => {
    const result = await importSkill(
      store,
      {
        name: 'Not Valid!',
        files: [{ path: 'SKILL.md', contentBase64: b64('x') }],
      },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_name');
  });

  it('rejects an empty or absent files array', async () => {
    const missing = await importSkill(store, { name: 'demo' }, world.rows);
    expect((missing.body as { error: { code: string } }).error.code).toBe('missing_files');
    const empty = await importSkill(store, { name: 'demo', files: [] }, world.rows);
    expect((empty.body as { error: { code: string } }).error.code).toBe('missing_files');
  });

  it('rejects a files array with no SKILL.md', async () => {
    const result = await importSkill(
      store,
      {
        name: 'demo',
        files: [{ path: 'readme.txt', contentBase64: b64('x') }],
      },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('missing_skill_md');
  });

  it('rejects a duplicate path within one import', async () => {
    const result = await importSkill(
      store,
      {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
          { path: 'SKILL.md', contentBase64: b64('different') },
        ],
      },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('duplicate_path');
  });

  it('rejects content that is not valid base64, rather than silently truncating it', async () => {
    const result = await importSkill(
      store,
      {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: 'not base64!!! ###' }],
      },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('malformed_content');
  });

  it('rejects a path that traverses out of the skill directory, by grammar, before any write', async () => {
    // Round 3 (ADR-0044): `..` is refused by `isAdmissibleRelativePath` in `validateImportBody`,
    // before `skillFileKey`/`store.put` ever run — so this is `inadmissible_path` now, not the
    // downstream `invalid_path` `key-safety.ts` would have reported had this request reached it.
    // Nothing is written for a request rejected at validation time, and neither the `SKILL.md`
    // entry nor the traversal attempt reaches the store — the whole import is refused as one unit.
    const result = await importSkill(
      store,
      {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
          { path: '../escape.txt', contentBase64: b64('x') },
        ],
      },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('inadmissible_path');
    // Nothing was written at all: not even the well-formed SKILL.md entry that preceded the bad one.
    expect(await listAll(store, '')).toEqual([]);
    expect(await catalog.listFiles()).toEqual([]);
  });

  it('refuses every character-class alias that defeated round 1 and round 2 (ADR-0044, B1/B2)', async () => {
    for (const path of ['SKILL.md::$DATA', 'SKILL.md.', 'SKILL.md ', 'a$b', 'a:b']) {
      const result = await importSkill(
        store,
        {
          name: 'demo',
          files: [
            { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
            { path, contentBase64: b64('impostor') },
          ],
        },
        world.rows,
      );
      expect(result.status, path).toBe(400);
      expect((result.body as { error: { code: string } }).error.code, path).toBe(
        'inadmissible_path',
      );
    }
    // None of the attempts above created anything at all — not even a one-file "demo".
    const result = await getSkill(store, 'demo', world.rows);
    expect(result.status).toBe(404);
  });

  it('rejects importing the same name twice', async () => {
    await importMinimal('demo');
    const result = await importSkill(
      store,
      {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) }],
      },
      world.rows,
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe('skill_already_exists');
  });
});

describe('getSkill', () => {
  it('404s a skill that was never imported', async () => {
    const result = await getSkill(store, 'nope', world.rows);
    expect(result.status).toBe(404);
  });

  it('200s with the same shape importSkill returned', async () => {
    const imported = await importMinimal();
    const result = await getSkill(store, 'demo', world.rows);
    expect(result.status).toBe(200);
    expect((result.body as { skill: SkillDetail }).skill).toEqual(imported);
  });
});

describe('listSkills', () => {
  it('lists nothing in a fresh workspace', async () => {
    const result = await listSkills(store, world.rows);
    expect((result.body as { skills: unknown[] }).skills).toEqual([]);
  });

  it('lists every imported skill, sorted by name', async () => {
    await importMinimal('zebra');
    await importMinimal('alpha');
    const result = await listSkills(store, world.rows);
    const names = (result.body as { skills: { name: string }[] }).skills.map((s) => s.name);
    expect(names).toEqual(['alpha', 'zebra']);
  });
});

describe('patchSkill', () => {
  it('404s a skill that does not exist', async () => {
    const result = await patchSkill(store, 'nope', { enabled: false }, world.rows);
    expect(result.status).toBe(404);
  });

  it('rejects an empty patch', async () => {
    await importMinimal();
    const result = await patchSkill(store, 'demo', {}, world.rows);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('empty_patch');
  });

  it('toggles enabled', async () => {
    await importMinimal();
    const disabled = await patchSkill(store, 'demo', { enabled: false }, world.rows);
    expect((disabled.body as { skill: SkillDetail }).skill.enabled).toBe(false);
    const reEnabled = await patchSkill(store, 'demo', { enabled: true }, world.rows);
    expect((reEnabled.body as { skill: SkillDetail }).skill.enabled).toBe(true);
  });

  it('adds a supporting file', async () => {
    await importMinimal();
    const patched = await patchSkill(
      store,
      'demo',
      {
        files: [{ path: 'scripts/run.sh', contentBase64: b64('echo hi') }],
      },
      world.rows,
    );
    expect(patched.status).toBe(200);
    const skill = (patched.body as { skill: SkillDetail }).skill;
    expect(skill.fileCount).toBe(2);
    expect(skill.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
  });

  it('removes a supporting file', async () => {
    await importSkill(
      store,
      {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
          { path: 'scripts/run.sh', contentBase64: b64('echo hi') },
        ],
      },
      world.rows,
    );
    const patched = await patchSkill(
      store,
      'demo',
      { removeFiles: ['scripts/run.sh'] },
      world.rows,
    );
    expect(patched.status).toBe(200);
    const skill = (patched.body as { skill: SkillDetail }).skill;
    expect(skill.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('refuses to remove SKILL.md', async () => {
    await importMinimal();
    const result = await patchSkill(store, 'demo', { removeFiles: ['SKILL.md'] }, world.rows);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('cannot_remove_skill_md');
    // And nothing was removed: the skill still has its SKILL.md.
    const after = await getSkill(store, 'demo', world.rows);
    expect((after.body as { skill: SkillDetail }).skill.files.map((f) => f.path)).toEqual([
      'SKILL.md',
    ]);
  });

  it('updates updatedAt but not createdAt', async () => {
    const original = await importMinimal();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const patched = await patchSkill(store, 'demo', { enabled: false }, world.rows);
    const skill = (patched.body as { skill: SkillDetail }).skill;
    expect(skill.createdAt).toBe(original.createdAt);
    expect(skill.updatedAt).not.toBe(original.updatedAt);
  });

  it('refuses removeFiles["SKILL.md::$DATA"] — the exact B1 counter-example, on a real NTFS-backed store', async () => {
    // Round 2 shipped a case-fold guard that this alias walked straight past —
    // 'SKILL.md::$DATA'.toLowerCase() !== 'skill.md' — reaching `store.delete` and destroying
    // SKILL.md on this platform's real filesystem. Round 3's admission grammar refuses ':' and '$'
    // outright, so this never reaches `store.delete` at all: `validatePatchBody` rejects it before
    // `patchSkill`'s body even runs.
    await importSkill(
      store,
      {
        name: 'demo-ads',
        files: [
          { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
          { path: 'notes.txt', contentBase64: b64('notes') },
        ],
      },
      world.rows,
    );
    const result = await patchSkill(
      store,
      'demo-ads',
      { removeFiles: ['SKILL.md::$DATA'] },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('inadmissible_path');
    // SKILL.md is untouched — this is the real local-filesystem backend, on this real host.
    const after = await getSkill(store, 'demo-ads', world.rows);
    expect(after.status).toBe(200);
    expect((after.body as { skill: SkillDetail }).skill.files.map((f) => f.path).sort()).toEqual([
      'SKILL.md',
      'notes.txt',
    ]);
  });

  it('restores SKILL.md when the post-delete read-back finds it gone, for a route the grammar could not predict', async () => {
    // This is ADR-0044's second half, exercised directly: everything the grammar and the two prior
    // rounds' aliases can reach is already refused before `store.delete` runs (the test above), so
    // this test drives the read-back/restore path itself with a store double that models "a backend
    // did something no grammar predicted" — deleting an unrelated admitted key collaterally deletes
    // SKILL.md too. `patchSkill` must notice on its post-mutation read-back, restore SKILL.md from
    // what it captured immediately beforehand, and refuse the request rather than reporting 200.
    await importSkill(
      store,
      {
        name: 'demo-collateral',
        files: [
          { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
          { path: 'trigger.txt', contentBase64: b64('x') },
        ],
      },
      world.rows,
    );
    const folder = skillRowFolder('demo-collateral');
    const { storage } = world;
    const collateralRows: SkillRowsWriter = {
      ...world.rows,
      storage: {
        ...storage,
        remove: async (ctx, area, rowPath, options) => {
          if (rowPath === `${folder}/trigger.txt`) {
            // Simulate a backend that also removes SKILL.md as a side effect of this unrelated
            // delete — precisely the class of thing no string grammar can predict (ADR-0044).
            await storage.remove(ctx, area, `${folder}/SKILL.md`, options);
          }
          return storage.remove(ctx, area, rowPath, options);
        },
      },
    };
    const result = await patchSkill(
      store,
      'demo-collateral',
      { removeFiles: ['trigger.txt'] },
      collateralRows,
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'skill_md_removal_rejected',
    );
    // SKILL.md was restored — the request is refused, not left broken.
    const after = await getSkill(store, 'demo-collateral', world.rows);
    expect(after.status).toBe(200);
    const skill = (after.body as { skill: SkillDetail }).skill;
    expect(skill.instructions).toBe('\nDo the thing.\n');
  });

  // ── Round 4, B2-PATCH (ADR-0048) ────────────────────────────────────────────────────────────
  //
  // The frozen list's own reproduction, verbatim, against this real local-filesystem store: a
  // grammar-admissible `skill.md` reaching the filesystem as `SKILL.md`, through PATCH's `files`
  // array, which round 3 never gave a case-fold check to (only `POST`'s `validateImportBody` and
  // this same function's own `removeFiles` handling had one). Both the two-entry shape (B2's own
  // shape, replayed on PATCH) and the single-entry shape (a write through an alias, no second entry
  // required) are driven below, each followed by a read-back proving nothing was corrupted.

  it('refuses a two-entry PATCH files array that collides case-fold — the exact B2-PATCH counter-example', async () => {
    await importSkill(
      store,
      {
        name: 'd1',
        files: [{ path: 'SKILL.md', contentBase64: b64('THE REAL SKILL\n') }],
      },
      world.rows,
    );
    const result = await patchSkill(
      store,
      'd1',
      {
        files: [
          { path: 'SKILL.md', contentBase64: b64('THE REAL SKILL\n') },
          { path: 'skill.md', contentBase64: b64('impostor\n') },
        ],
      },
      world.rows,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe('colliding_paths');
    // Nothing was written by the refused patch: SKILL.md is exactly what it was after import.
    const after = await getSkill(store, 'd1', world.rows);
    expect(after.status).toBe(200);
    const skill = (after.body as { skill: SkillDetail }).skill;
    expect(skill.fileCount).toBe(1);
    expect(skill.files).toEqual([
      { path: 'SKILL.md', sizeBytes: Buffer.byteLength('THE REAL SKILL\n') },
    ]);
    expect(skill.instructions).toBe('THE REAL SKILL\n');
  });

  it('refuses a single-entry PATCH files array that aliases an existing file — no second entry required', async () => {
    // This is the shape the two-entry test above cannot exercise: nothing in the *request* collides
    // with anything else in the *request*. The collision is with a file the skill already has, which
    // is exactly why `createCaseFoldGuard` is seeded from the skill's existing directory rather than
    // only checking `files` against itself.
    await importSkill(
      store,
      {
        name: 'a8',
        files: [{ path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) }],
      },
      world.rows,
    );
    const result = await patchSkill(
      store,
      'a8',
      {
        files: [
          {
            path: 'skill.md',
            contentBase64: b64('---\nname: x\ndescription: HIJACKED\n---\nEVIL\n'),
          },
        ],
      },
      world.rows,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe('colliding_paths');
    // The original SKILL.md survives untouched — no HIJACKED description, no EVIL instructions.
    const after = await getSkill(store, 'a8', world.rows);
    expect(after.status).toBe(200);
    const skill = (after.body as { skill: SkillDetail }).skill;
    expect(skill.description).toBe('A demo skill');
    expect(skill.instructions).toBe('\nDo the thing.\n');
    expect(skill.files).toEqual([
      { path: 'SKILL.md', sizeBytes: Buffer.byteLength(MINIMAL_SKILL_MD) },
    ]);
  });

  it("still allows re-supplying SKILL.md's own exact spelling — an ordinary content edit, not a collision", async () => {
    await importMinimal('demo-edit');
    const edited = '---\nname: demo-edit\ndescription: updated\n---\n\nNew body.\n';
    const result = await patchSkill(
      store,
      'demo-edit',
      {
        files: [{ path: 'SKILL.md', contentBase64: b64(edited) }],
      },
      world.rows,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const skill = (result.body as { skill: SkillDetail }).skill;
    expect(skill.description).toBe('updated');
    expect(skill.instructions).toBe('\nNew body.\n');
  });

  it('rejects a duplicate exact path within one PATCH files array, the same as POST does', async () => {
    await importMinimal('demo-dup');
    const result = await patchSkill(
      store,
      'demo-dup',
      {
        files: [
          { path: 'notes.txt', contentBase64: b64('a') },
          { path: 'notes.txt', contentBase64: b64('b') },
        ],
      },
      world.rows,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('duplicate_path');
    const after = await getSkill(store, 'demo-dup', world.rows);
    expect((after.body as { skill: SkillDetail }).skill.fileCount).toBe(1); // just SKILL.md
  });
});

describe('exportSkill', () => {
  it('404s a skill that does not exist', async () => {
    const result = await exportSkill(store, 'nope', world.rows);
    expect(result.status).toBe(404);
  });

  it('re-serves every imported file, base64 for base64 equal to what a decoder of the stored bytes would produce', async () => {
    await importSkill(
      store,
      {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: b64(MINIMAL_SKILL_MD) },
          { path: 'scripts/run.sh', contentBase64: b64('#!/bin/sh\necho hi') }, // no trailing newline
        ],
      },
      world.rows,
    );
    const result = await exportSkill(store, 'demo', world.rows);
    expect(result.status).toBe(200);
    const files = (result.body as { skill: { files: { path: string; contentBase64: string }[] } })
      .skill.files;
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.contentBase64]));
    expect(Buffer.from(byPath['SKILL.md'] ?? '', 'base64')).toEqual(
      Buffer.from(MINIMAL_SKILL_MD, 'utf8'),
    );
    expect(Buffer.from(byPath['scripts/run.sh'] ?? '', 'base64')).toEqual(
      Buffer.from('#!/bin/sh\necho hi', 'utf8'),
    );
  });
});
