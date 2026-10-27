/**
 * `builtin.ts` against the local-filesystem {@link ObjectStore} and an in-memory catalog: a
 * built-in skill is installed on first use, refreshed only while it is still what this platform
 * installed, and never replaces a skill the user owns.
 */
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
  UnsafeObjectKeyError,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';
import { builtinSkillFiles } from '@agent-workspace/skills-office';

import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { digestOf, ensureBuiltinSkills, installBuiltinSkillsNamedBy } from './builtin';
import {
  skillBuiltinMarkerKey,
  skillDeleteMarkerKey,
  skillFilesPrefix,
  skillFileKey,
  skillRowFolder,
} from './keys';
import { createSkillRowsWorld } from './rows-fixture';
import { getSkillWithId, importSkillWithId } from './service';
import { skillFiles, skillWriter, type SkillRowsWriter } from './tree';

const WORKSPACE_ID = '88888888-8888-4888-8888-888888888888';
const PRINCIPAL = { ownerPrincipalId: 'test-owner', userId: null, workspaceId: WORKSPACE_ID };
const NAME = 'office-reader';
const text = (value: string): string => Buffer.from(value).toString('base64');

let rootDir: string;
let store: ObjectStoreV2;
let catalogOfTest: ResourceCatalogRepository;
let world: ReturnType<typeof createSkillRowsWorld>;

function newCatalog(): { catalog: ResourceCatalogRepository; names: () => Promise<string[]> } {
  const catalog = catalogOfTest;
  return { catalog, names: async () => (await catalog.listSkills()).map((skill) => skill.name) };
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'skills-builtin-'));
  store = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
  catalogOfTest = createInMemoryCatalogStore().forWorkspaceSync(WORKSPACE_ID);
  world = createSkillRowsWorld(createInMemoryObjectStore(), WORKSPACE_ID, catalogOfTest);
});

afterEach(async () => {
  clearApplicationContext();
  await rm(rootDir, { recursive: true, force: true });
});

async function bytesOf(relativePath: string): Promise<string | null> {
  const files = await skillFiles(store, world.rows, skillRowFolder(NAME), skillFilesPrefix(NAME));
  const bytes = await files.find((file) => file.relativePath === relativePath)?.read();
  return bytes === undefined || bytes === null ? null : Buffer.from(bytes).toString('utf8');
}

/** Install an older release of the skill, as this platform would have recorded it. */
async function installOlderRelease(catalog: ResourceCatalogRepository): Promise<void> {
  const old = [
    { path: 'SKILL.md', content: '---\nname: office-reader\ndescription: old\n---\nold\n' },
    { path: 'scripts/legacy.mjs', content: '// gone in the new release\n' },
  ];
  const imported = await importSkillWithId(
    store,
    catalog,
    PRINCIPAL,
    {
      name: NAME,
      files: old.map((file) => ({ path: file.path, contentBase64: text(file.content) })),
    },
    world.rows,
  );
  expect(imported.status).toBe(201);
  const digest = digestOf(
    old.map((file) => ({ path: file.path, bytes: Buffer.from(file.content) })),
  );
  await store.put(skillBuiltinMarkerKey(NAME), {
    body: Buffer.from(JSON.stringify({ digest })),
    contentType: 'application/json',
  });
}

describe('ensureBuiltinSkills', () => {
  it('installs a built-in skill on first use, byte for byte, with a catalog row', async () => {
    const { catalog, names } = newCatalog();
    await ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME], world.rows);

    expect(await names()).toEqual([NAME]);
    for (const file of builtinSkillFiles(NAME)) {
      expect(await bytesOf(file.path)).toBe(Buffer.from(file.contentBase64, 'base64').toString());
    }
    const read = await getSkillWithId(store, catalog, PRINCIPAL, NAME, world.rows);
    expect(read.status).toBe(200);
  });

  it('does nothing the second time and ignores names that are not built in', async () => {
    const { catalog, names } = newCatalog();
    await ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME, 'my-own-skill', NAME], world.rows);
    const before = await store.get(skillBuiltinMarkerKey(NAME));
    await ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME], world.rows);
    expect(await store.get(skillBuiltinMarkerKey(NAME))).toEqual(before);
    expect(await store.get(skillFileKey('my-own-skill', 'SKILL.md'))).toBeNull();
    expect(await names()).toEqual([NAME]);
  });

  it('refreshes an unmodified older install and drops files the new release no longer has', async () => {
    const { catalog } = newCatalog();
    await installOlderRelease(catalog);

    await ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME], world.rows);

    const shipped = builtinSkillFiles(NAME).find((file) => file.path === 'SKILL.md');
    expect(await bytesOf('SKILL.md')).toBe(
      Buffer.from(shipped?.contentBase64 ?? '', 'base64').toString(),
    );
    expect(await bytesOf('scripts/legacy.mjs')).toBeNull();
    expect(await bytesOf('scripts/pdf.mjs')).not.toBeNull();
  });

  it('leaves an install the user edited after the platform put it there', async () => {
    const { catalog } = newCatalog();
    await installOlderRelease(catalog);
    await skillWriter(store, world.rows, NAME).put(
      'SKILL.md',
      Buffer.from('---\nname: office-reader\ndescription: mine\n---\nmine\n'),
    );

    await ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME], world.rows);

    expect(await bytesOf('SKILL.md')).toContain('mine');
    expect(await bytesOf('scripts/legacy.mjs')).not.toBeNull();
  });

  it('never replaces a skill the user imported under the same name', async () => {
    const { catalog } = newCatalog();
    const mine = '---\nname: office-reader\ndescription: mine\n---\nmine\n';
    await importSkillWithId(
      store,
      catalog,
      PRINCIPAL,
      {
        name: NAME,
        files: [{ path: 'SKILL.md', contentBase64: text(mine) }],
      },
      world.rows,
    );

    await ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME], world.rows);

    expect(await bytesOf('SKILL.md')).toBe(mine);
    expect(await bytesOf('scripts/pdf.mjs')).toBeNull();
    expect(await store.get(skillBuiltinMarkerKey(NAME))).toBeNull();
  });

  it('does not bring back a skill whose delete is pending', async () => {
    const { catalog, names } = newCatalog();
    await store.put(skillDeleteMarkerKey(NAME), {
      body: Buffer.from('{}'),
      contentType: 'application/json',
    });

    await ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME], world.rows);

    expect(await names()).toEqual([]);
    expect(await bytesOf('SKILL.md')).toBeNull();
  });

  it('throws when the install is refused, instead of leaving the save to report a missing skill', async () => {
    const { catalog, names } = newCatalog();
    const refusing: SkillRowsWriter = {
      ...world.rows,
      storage: {
        ...world.storage,
        save: () => Promise.reject(new UnsafeObjectKeyError('absolute', NAME, 'refused by test')),
      },
    };

    await expect(ensureBuiltinSkills(store, catalog, PRINCIPAL, [NAME], refusing)).rejects.toThrow(
      `installing built-in skill ${NAME} answered 400`,
    );
    expect(await names()).toEqual([]);
  });
});

describe('installBuiltinSkillsNamedBy', () => {
  function configure(): { names: () => Promise<string[]> } {
    const { catalog, names } = newCatalog();
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_ID }),
          store: { forWorkspace: () => store },
          catalog: { forWorkspace: () => Promise.resolve(catalog) },
          storage: world.storage,
        },
      },
    });
    return { names };
  }

  it('installs the built-in skills a version body names', async () => {
    const { names } = configure();
    await installBuiltinSkillsNamedBy(
      { definition: { resources: { skills: [NAME, 'my-own-skill'] } } },
      PRINCIPAL,
    );
    expect(await names()).toEqual([NAME]);
  });

  it('does nothing for a body that names none, or is not a body at all', async () => {
    const { names } = configure();
    await installBuiltinSkillsNamedBy({ definition: { resources: { skills: ['x'] } } }, PRINCIPAL);
    await installBuiltinSkillsNamedBy(undefined, PRINCIPAL);
    await installBuiltinSkillsNamedBy('nope', PRINCIPAL);
    expect(await names()).toEqual([]);
  });

  it('does nothing when the deployment has no skills runtime', async () => {
    await installBuiltinSkillsNamedBy({ definition: { resources: { skills: [NAME] } } }, PRINCIPAL);
    expect(await bytesOf('SKILL.md')).toBeNull();
  });
});
