/**
 * `service.ts` against the local-filesystem {@link ObjectStore} and an in-memory catalog, with no
 * Next.js route module involved.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourceCatalogRepository } from '@agent-workspace/core/db';

import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { SkillDetail } from './handlers';
import { createSkillRowsWorld } from './rows-fixture';
import type { SkillRowsWriter } from './tree';
import type { SkillObjects } from '../storage/store';
import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
} from '@agent-workspace/core/storage';
import {
  catalogNotConfigured,
  getSkillWithId,
  importSkillWithId,
  listSkillsWithIds,
  patchSkillWithId,
} from './service';

const WORKSPACE_ID = '77777777-7777-4777-8777-777777777777';
const BOM = String.fromCharCode(0xfeff);
const PRINCIPAL = { ownerPrincipalId: 'test-owner', userId: null, workspaceId: WORKSPACE_ID };

/** The skills' rows of the test in progress; `open` records the row paths it reads in `readKeys`. */
let rows: SkillRowsWriter;

function newCatalog(): ResourceCatalogRepository {
  const catalog = createInMemoryCatalogStore().forWorkspaceSync(WORKSPACE_ID);
  const world = createSkillRowsWorld(createInMemoryObjectStore(), WORKSPACE_ID, catalog);
  rows = {
    ...world.rows,
    storage: {
      ...world.storage,
      open: (ctx, row) => {
        readKeys.push(row.path ?? '');
        return world.storage.open(ctx, row);
      },
    },
  };
  return catalog;
}

async function skillRow(catalog: ResourceCatalogRepository, name: string) {
  const row = (await catalog.listSkills()).find((skill) => skill.name === name);
  if (row === undefined) throw new Error(`no catalog row for ${name}`);
  return row;
}

let rootDir: string;
let store: SkillObjects;
let readKeys: string[];

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'skills-service-'));
  const inner = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
  readKeys = [];
  store = {
    put: (key, input) => inner.put(key, input),
    get: (key) => {
      readKeys.push(key);
      return inner.get(key);
    },
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
    listPrefix: (prefix) => inner.listPrefix(prefix),
    copyObject: (source, destination) => inner.copyObject(source, destination),
    read: (key, options) => inner.read(key, options),
    listPage: (prefix, options) => inner.listPage(prefix, options),
  };
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('getSkillWithId', () => {
  it("never reads a supporting file's bytes", async () => {
    const catalog = newCatalog();
    const imported = await importSkillWithId(
      store,
      catalog,
      PRINCIPAL,
      {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: b64('---\nname: demo\n---\n\nDo the thing.\n') },
          { path: 'scripts/run.py', contentBase64: b64('print("hi")\n') },
        ],
      },
      rows,
    );
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    readKeys.length = 0;

    const result = await getSkillWithId(store, catalog, PRINCIPAL, 'demo', rows);

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((result.body as { skill: { id?: string } }).skill.id).toBe(
      (await skillRow(catalog, 'demo')).id,
    );
    expect(readKeys.length).toBeGreaterThan(0);
    expect(readKeys.filter((key) => key.endsWith('scripts/run.py'))).toEqual([]);
  });
});

describe('importSkillWithId', () => {
  it('stores the SKILL.md text the response carries', async () => {
    const catalog = newCatalog();
    const imported = await importSkillWithId(
      store,
      catalog,
      PRINCIPAL,
      {
        name: 'bom',
        files: [{ path: 'SKILL.md', contentBase64: b64(`${BOM}---\nname: bom\n---\n\nBody.\n`) }],
      },
      rows,
    );

    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const skill = (imported.body as { skill: SkillDetail & { id: string } }).skill;
    expect(skill.source).not.toBeNull();
    expect(skill.source?.startsWith(BOM)).toBe(false);
    const row = await skillRow(catalog, 'bom');
    expect(row.skillMd).toBe(skill.source);
    expect(skill.id).toBe(row.id);
  });
});

describe('importSkillWithId under concurrent imports of one name', () => {
  const skillFiles = (text: string): { path: string; contentBase64: string }[] => [
    { path: 'SKILL.md', contentBase64: b64(text) },
  ];

  it("never lets a failed import's rollback delete the other import's skill", async () => {
    const catalog = newCatalog();
    const working = catalog.putSkill.bind(catalog);
    vi.spyOn(catalog, 'putSkill').mockImplementation(async (input) => {
      if (!input.skillMd.includes('from B')) return working(input);
      await new Promise((done) => setTimeout(done, 25));
      throw new Error('database blip');
    });
    const textA = '---\nname: dup\n---\n\nfrom A\n';
    const textB = '---\nname: dup\n---\n\nfrom B\n';

    const [a, b] = await Promise.allSettled([
      importSkillWithId(store, catalog, PRINCIPAL, { name: 'dup', files: skillFiles(textA) }, rows),
      importSkillWithId(store, catalog, PRINCIPAL, { name: 'dup', files: skillFiles(textB) }, rows),
    ]);

    expect(a.status === 'fulfilled' ? a.value.status : null).toBe(201);
    expect(b.status === 'fulfilled' ? b.value.status : null).toBe(409);
    expect((await skillRow(catalog, 'dup')).skillMd).toBe(textA);
    const listed = await listSkillsWithIds(store, catalog, PRINCIPAL, rows);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const got = await getSkillWithId(store, catalog, PRINCIPAL, 'dup', rows);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect((got.body as { skill: SkillDetail }).skill.source).toBe(textA);
  });

  it('rolls back a failed import so the name can be imported again', async () => {
    const catalog = newCatalog();
    vi.spyOn(catalog, 'putSkill').mockRejectedValueOnce(new Error('database blip'));
    const text = '---\nname: retry\n---\n\nBody.\n';

    await expect(
      importSkillWithId(
        store,
        catalog,
        PRINCIPAL,
        { name: 'retry', files: skillFiles(text) },
        rows,
      ),
    ).rejects.toThrow('database blip');
    const again = await importSkillWithId(
      store,
      catalog,
      PRINCIPAL,
      {
        name: 'retry',
        files: skillFiles(text),
      },
      rows,
    );
    expect(again.status).toBe(201);
  });
});

describe('patchSkillWithId', () => {
  it('keeps the patched bytes when the catalog write fails and the next GET re-syncs the row', async () => {
    const catalog = newCatalog();
    const original = '---\nname: edit\n---\n\nOld.\n';
    const patchedText = '---\nname: edit\n---\n\nNew.\n';
    const imported = await importSkillWithId(
      store,
      catalog,
      PRINCIPAL,
      {
        name: 'edit',
        files: [{ path: 'SKILL.md', contentBase64: b64(original) }],
      },
      rows,
    );
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);

    vi.spyOn(catalog, 'putSkill').mockRejectedValueOnce(new Error('database blip'));
    await expect(
      patchSkillWithId(
        store,
        catalog,
        PRINCIPAL,
        'edit',
        {
          files: [{ path: 'SKILL.md', contentBase64: b64(patchedText) }],
        },
        rows,
      ),
    ).rejects.toThrow('database blip');
    expect((await skillRow(catalog, 'edit')).skillMd).toBe(original);

    const got = await getSkillWithId(store, catalog, PRINCIPAL, 'edit', rows);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect((got.body as { skill: SkillDetail }).skill.source).toBe(patchedText);
    expect((await skillRow(catalog, 'edit')).skillMd).toBe(patchedText);
  });
});

describe('catalogNotConfigured', () => {
  it('answers the documented 503', () => {
    const result = catalogNotConfigured();

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: {
        code: 'skills_runtime_not_configured',
        message:
          'The skills catalog is not configured for this deployment; every skill needs a catalog ' +
          'id, and none can be produced without one.',
      },
    });
  });
});
