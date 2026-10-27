/**
 * The skills service when two servers act on one skill name (the storage design, §01 "Servers can
 * conflict"; §04 "Saving a file"). Each case runs on the in-memory catalog and on PostgreSQL; the
 * two "servers" are two catalog handles (two connection pools on PostgreSQL) over one object store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentSkills,
  agents,
  closeIsolatedTestResources,
  connect,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  readBytes,
  type ObjectStore,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';

import { builtinSkillFiles } from '@agent-workspace/skills-office';

import { ensureBuiltinSkills } from './builtin';
import { deleteSkill } from './delete';
import { exportSkill, getSkill } from './handlers';
import {
  getSkillWithId,
  importSkillWithId,
  patchSkillWithId,
  publishSkillRevisionWithId,
  type SkillPrincipal,
} from './service';
import { skillFilesPrefix, skillFileKey, skillRowFolder } from './keys';
import { createSkillRowsWorld, seedBareSkill } from './rows-fixture';
import { skillFiles, walkFiles, type SkillRowsAccess } from './tree';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** Connections in the second server's pool, so a test can run one more request than it holds. */
const SECOND_POOL_SIZE = 4;

interface Fixture {
  readonly principal: SkillPrincipal & { readonly workspaceId: string };
  /** One catalog handle per server. */
  readonly catalogs: readonly [ResourceCatalogRepository, ResourceCatalogRepository];
  /** Assign the skill `name` to a new agent, as the catalog under test records it. */
  readonly assign: (name: string) => Promise<void>;
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const skillMd = (who: string): string => `---\nname: dup\n---\n\nfrom ${who}\n`;
const runSh = (who: string): string => `echo ${who}\n`;
const importBody = (who: string) => ({
  name: 'dup',
  files: [
    { path: 'SKILL.md', contentBase64: b64(skillMd(who)) },
    { path: 'scripts/run.sh', contentBase64: b64(runSh(who)) },
  ],
});

/** Wraps an object store so its first `write` waits until `release()` is called. */
function gatedFirstWrite() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let gated = false;
  const wrap = (inner: ObjectStoreV2): ObjectStoreV2 => ({
    ...inner,
    write: async (name, body, options) => {
      if (!gated) {
        gated = true;
        enter();
        await released;
      }
      return inner.write(name, body, options);
    },
  });
  return { wrap, entered, release };
}

/** The rows of one server: its catalog handle, over `objects`, saving for the fixture's owner. */
function serverRows(
  principal: Fixture['principal'],
  catalog: ResourceCatalogRepository,
  objects: ObjectStoreV2,
) {
  return createSkillRowsWorld(objects, principal.workspaceId, catalog, {
    principalId: principal.ownerPrincipalId,
    userId: principal.userId,
  }).rows;
}

async function textAt(store: ObjectStore, key: string): Promise<string | null> {
  const object = await store.get(key);
  return object === null ? null : new TextDecoder().decode(object.body);
}

function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    principal: { ownerPrincipalId: 'owner', userId: null, workspaceId },
    catalogs: [provider.forWorkspace(workspaceId), provider.forWorkspace(workspaceId)],
    assign: (name) => {
      provider.forWorkspace(workspaceId).assignSkill(name, crypto.randomUUID());
      return Promise.resolve();
    },
  });
}

let isolated: IsolatedTestDatabase | undefined;
let secondPool: { end(): Promise<void> } | undefined;
let secondDb: ReturnType<typeof connect>['db'] | undefined;

beforeAll(async () => {
  if (!hasDatabase) return;
  isolated = await createIsolatedTestDatabase('aw_skills_service_storage');
  const second = connect({ url: isolated.url, maxConnections: SECOND_POOL_SIZE });
  secondPool = second.pool;
  secondDb = second.db;
}, 180_000);

afterAll(async () => {
  if (isolated === undefined) return;
  await closeIsolatedTestResources(isolated, { close: async () => secondPool?.end() });
});

async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined || secondDb === undefined) {
    throw new Error('the PostgreSQL suite needs TEST_DATABASE_URL; run it through `pnpm test`');
  }
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'skills' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const catalogOn = async (handle: typeof db): Promise<ResourceCatalogRepository> => {
    const scope = await createDatabaseWorkspaceScopeResolver(handle).forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('catalog scope did not resolve');
    return createDatabaseResourceCatalogRepositoryProvider(handle).forScope(scope);
  };
  return {
    principal: { ownerPrincipalId: principalId, userId, workspaceId },
    catalogs: [await catalogOn(db), await catalogOn(secondDb)],
    assign: async (name) => {
      const skill = (await (await catalogOn(db)).listSkills()).find((row) => row.name === name);
      if (skill === undefined) throw new Error(`no skill named ${name} to assign`);
      const agentId = crypto.randomUUID();
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        name: 'Skill assignee',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        ownerPrincipalId: principalId,
        createdBy: userId,
      });
      await db.insert(agentSkills).values({ workspaceId, agentId, skillId: skill.id });
    },
  };
}

function defineSuite(name: string, setup: () => Promise<Fixture>, ready: boolean): void {
  describe(`skill import on the ${name}`, () => {
    if (!ready) {
      it('has the database it needs', () => {
        throw new Error(
          'TEST_DATABASE_URL is not set; the PostgreSQL suite must run in `pnpm test`',
        );
      });
      return;
    }

    /** The catalog service the rows are saved through, plus helpers to read what it holds. */
    async function rowsWorld(
      wrap: (objects: ObjectStoreV2) => ObjectStoreV2 = (o) => o,
      server: 0 | 1 = 0,
    ) {
      const { principal, catalogs, assign } = await setup();
      const shared = createInMemoryObjectStoreProvider().forWorkspace(principal.workspaceId);
      const objects = createInMemoryObjectStore();
      /** The rows of one server (its catalog handle) over `over` objects, shared by default. */
      const onServer = (which: 0 | 1, over: ObjectStoreV2 = objects) =>
        serverRows(principal, catalogs[which], over);
      const { storage, rows } = createSkillRowsWorld(
        wrap(objects),
        principal.workspaceId,
        catalogs[server],
        { principalId: principal.ownerPrincipalId, userId: principal.userId },
      );
      const ctx = { workspaceId: principal.workspaceId, principalId: principal.ownerPrincipalId };
      const saveRow = async (path: string, text: string) => {
        const saved = await storage.save(
          { ...ctx, userId: principal.userId },
          {
            area: 'skills',
            path,
            maxBytes: 1024,
            replace: true,
            body: bytesToStream(new TextEncoder().encode(text)),
          },
        );
        if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      };
      const rowTexts = async (folder: string): Promise<Record<string, string>> => {
        const listed = await storage.list({ workspaceId: principal.workspaceId }, 'skills', folder);
        const out: Record<string, string> = {};
        for (const row of listed.rows) {
          const opened = await storage.open({ workspaceId: principal.workspaceId }, row);
          if (opened === null) throw new Error(`${row.path} has no bytes`);
          out[row.path] = new TextDecoder().decode(
            (await readBytes(opened.body, 1024)) ?? undefined,
          );
        }
        return out;
      };
      return {
        principal,
        catalogs,
        assign,
        shared,
        objects,
        storage,
        rows,
        onServer,
        saveRow,
        rowTexts,
      };
    }

    // @story US-STO-08
    it('[US-STO-08][api][sdk] two concurrent imports of one skill name: one 201, one 409, the winner files intact', async () => {
      const { principal, catalogs, shared, objects, rowTexts, onServer } = await rowsWorld();
      const gate = gatedFirstWrite();

      const first = importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('A'),
        onServer(0, gate.wrap(objects)),
      );
      try {
        await gate.entered;
        const second = await Promise.race([
          importSkillWithId(shared, catalogs[1], principal, importBody('B'), onServer(1)),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 2000)),
        ]);
        expect(second).toMatchObject({
          status: 409,
          body: { error: { code: 'skill_already_exists' } },
        });
        expect(await rowTexts('.skills/dup')).toEqual({});
      } finally {
        gate.release();
      }

      expect((await first).status).toBe(201);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('A'),
        '.skills/dup/scripts/run.sh': runSh('A'),
      });
      for (const catalog of catalogs) {
        const listed = await catalog.listSkills();
        expect(listed.map((row) => [row.name, row.skillMd])).toEqual([['dup', skillMd('A')]]);
      }
    }, 30_000);

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a failed import releases the name; a retry succeeds', async () => {
      const { principal, catalogs, shared, objects, rowTexts, onServer } = await rowsWorld();
      let writes = 0;
      const failing = onServer(0, {
        ...objects,
        write: (name, body, options) => {
          writes += 1;
          return writes === 3
            ? Promise.reject(new Error('disk blip'))
            : objects.write(name, body, options);
        },
      });
      // The failed import writes SKILL.md and a file the retry does not, then fails.
      const first = importBody('A');
      const withStale = {
        ...first,
        files: [
          first.files[0],
          { path: 'scripts/stale.sh', contentBase64: b64('stale\n') },
          first.files[1],
        ],
      };

      await expect(
        importSkillWithId(shared, catalogs[0], principal, withStale, failing),
      ).rejects.toThrow('disk blip');
      await expect(catalogs[1].listSkills()).resolves.toEqual([]);
      expect(await rowTexts('.skills/dup')).toEqual({});

      const retry = await importSkillWithId(
        shared,
        catalogs[1],
        principal,
        importBody('B'),
        onServer(1),
      );
      expect(retry.status).toBe(201);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('B'),
        '.skills/dup/scripts/run.sh': runSh('B'),
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a failed import keeps a row another import reserved under the name since', async () => {
      const { principal, catalogs, shared, objects, onServer } = await rowsWorld();
      const other = {
        name: 'dup',
        skillMd: skillMd('B'),
        enabled: true,
        ownerPrincipalId: principal.ownerPrincipalId,
      };
      let writes = 0;
      // While the import runs, its row is deleted and the name reserved again by another import.
      const failing = onServer(0, {
        ...objects,
        write: async (name, body, options) => {
          writes += 1;
          if (writes < 2) return objects.write(name, body, options);
          await catalogs[1].deleteSkill('dup');
          await catalogs[1].createSkill(other);
          throw new Error('disk blip');
        },
      });

      await expect(
        importSkillWithId(shared, catalogs[0], principal, importBody('A'), failing),
      ).rejects.toThrow('disk blip');

      const rows = await catalogs[1].listSkills();
      expect(rows.map((row) => [row.name, row.skillMd])).toEqual([['dup', skillMd('B')]]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a built-in install completes into a row a crashed import left with no files', async () => {
      const { principal, catalogs, shared, onServer } = await rowsWorld();
      const name = 'office-reader';
      const rows = onServer(1);
      const orphan = await catalogs[0].createSkill({
        name,
        skillMd: '# crashed',
        enabled: true,
        ownerPrincipalId: principal.ownerPrincipalId,
        createdBy: principal.userId,
      });

      await ensureBuiltinSkills(shared, catalogs[1], principal, [name], rows);

      const files = await skillFiles(shared, rows, skillRowFolder(name), skillFilesPrefix(name));
      for (const file of builtinSkillFiles(name)) {
        const bytes = await files.find((found) => found.relativePath === file.path)?.read();
        expect(
          bytes === undefined || bytes === null ? null : Buffer.from(bytes).toString('base64'),
        ).toBe(file.contentBase64);
      }
      const listed = await catalogs[0].listSkills();
      expect(listed.map((row) => row.id)).toEqual([orphan?.id]);
      expect(listed[0]?.skillMd).not.toBe('# crashed');
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] an import over a skill stored before the catalog had rows answers 409 and keeps its files', async () => {
      const { principal, catalogs, shared, rows } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));

      const result = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('new'),
        rows,
      );

      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: 'skill_already_exists' } },
      });
      await expect(catalogs[0].listSkills()).resolves.toEqual([]);
      expect(await textAt(shared, skillFileKey('dup', 'SKILL.md'))).toBe(skillMd('old'));
      expect(await textAt(shared, skillFileKey('dup', 'scripts/run.sh'))).toBe(runSh('old'));
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] two concurrent publishes of one skill get numbers 1 and 2 and each revision holds exactly its own files', async () => {
      const { principal, catalogs, shared, objects, rows, rowTexts, onServer } = await rowsWorld();
      expect(
        (await importSkillWithId(shared, catalogs[0], principal, importBody('v0'), rows)).status,
      ).toBe(201);
      const gate = gatedFirstWrite();

      const first = publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: importBody('A').files },
        onServer(0, gate.wrap(objects)),
      );
      await gate.entered;
      const second = publishSkillRevisionWithId(
        shared,
        catalogs[1],
        principal,
        'dup',
        { files: importBody('B').files },
        onServer(1),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      gate.release();

      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status)).toEqual([201, 201]);
      expect(
        results.map((result) => (result.body as { revision: { number: number } }).revision.number),
      ).toEqual([1, 2]);
      for (const [number, who] of [
        [1, 'A'],
        [2, 'B'],
      ] as const) {
        const folder = `.skills/dup@${String(number)}`;
        expect(await rowTexts(folder)).toEqual({
          [`${folder}/SKILL.md`]: skillMd(who),
          [`${folder}/scripts/run.sh`]: runSh(who),
        });
      }
      expect((await rowTexts('.skills/dup'))['.skills/dup/SKILL.md']).toBe(skillMd('B'));
      expect((await catalogs[0].listSkills()).map((row) => row.skillMd)).toEqual([skillMd('B')]);
    }, 30_000);

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a publish the files refuse records no revision', async () => {
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
      await catalogs[0].createSkill({
        name: 'dup',
        skillMd: skillMd('reserved'),
        enabled: true,
        ownerPrincipalId: principal.ownerPrincipalId,
        createdBy: principal.userId,
      });

      const result = await publishSkillRevisionWithId(
        shared,
        catalogs[1],
        principal,
        'dup',
        { files: importBody('A').files },
        rows,
      );

      expect(result).toMatchObject({ status: 404, body: { error: { code: 'skill_not_found' } } });
      await expect(catalogs[0].listSkillRevisions('dup')).resolves.toEqual([]);
      expect(await rowTexts('.skills/dup@1')).toEqual({});
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] publishing a skill with no catalog row still works', async () => {
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));

      const result = await publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: importBody('A').files },
        rows,
      );

      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect((await catalogs[1].listSkills()).map((row) => row.skillMd)).toEqual([skillMd('A')]);
      expect((await rowTexts('.skills/dup@1'))['.skills/dup@1/SKILL.md']).toBe(skillMd('A'));
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] skill import saves through the service', async () => {
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();

      const imported = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('A'),
        rows,
      );

      expect(imported.status, JSON.stringify(imported.body)).toBe(201);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('A'),
        '.skills/dup/scripts/run.sh': runSh('A'),
      });
      expect(await walkFiles(shared, 'skills')).toEqual([]);
      const got = await getSkillWithId(shared, catalogs[0], principal, 'dup', rows);
      expect(got).toMatchObject({
        status: 200,
        body: { skill: { source: skillMd('A'), fileCount: 2 } },
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] GET /api/skills/:name reads a skill stored as rows (sizes, source, export)', async () => {
      const { principal, catalogs, shared, rows, saveRow } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));
      await saveRow('.skills/dup/SKILL.md', skillMd('rows'));
      await saveRow('.skills/dup/scripts/run.sh', runSh('rows'));
      await saveRow('.skills/dup/references/more.md', 'more');

      const got = await getSkillWithId(shared, catalogs[0], principal, 'dup', rows);
      expect(got).toMatchObject({
        status: 200,
        body: {
          skill: {
            source: skillMd('rows'),
            fileCount: 3,
            files: [
              { path: 'SKILL.md', sizeBytes: skillMd('rows').length },
              { path: 'references/more.md', sizeBytes: 4 },
              { path: 'scripts/run.sh', sizeBytes: runSh('rows').length },
            ],
          },
        },
      });
      const exported = await exportSkill(shared, 'dup', rows);
      expect(exported).toMatchObject({ status: 200 });
      const paths = (exported.body as { skill: { files: { path: string }[] } }).skill.files.map(
        (f) => f.path,
      );
      expect(paths).toEqual(['SKILL.md', 'references/more.md', 'scripts/run.sh']);
      // Without the service the same skill still reads from its prefix.
      expect(await getSkill(shared, 'dup')).toMatchObject({
        body: { skill: { source: skillMd('old'), fileCount: 2 } },
      });
    });

    // @story US-STO-08
    it("[US-STO-08][api][sdk] delete removes a skill's rows, its revision rows and their objects", async () => {
      const { principal, catalogs, shared, objects, rows, saveRow } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));
      await getSkillWithId(shared, catalogs[0], principal, 'dup');
      expect(
        (
          await publishSkillRevisionWithId(
            shared,
            catalogs[0],
            principal,
            'dup',
            {
              files: importBody('old').files,
            },
            rows,
          )
        ).status,
      ).toBe(201);
      await saveRow('.skills/dup/SKILL.md', skillMd('rows'));
      await saveRow('.skills/dup@1/SKILL.md', skillMd('rev'));
      await saveRow('.skills/dup-two/SKILL.md', skillMd('other'));

      expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toEqual({
        status: 204,
        body: null,
      });

      const left = (await catalogs[0].listFiles()).filter((row) => row.kind === 'file');
      expect(left.map((row) => row.path)).toEqual(['.skills/dup-two/SKILL.md']);
      expect(await walkFiles(shared, 'skills')).toEqual([]);
      expect(await objects.listPrefix('')).toHaveLength(1);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] delete removes the rows of a pending revision too', async () => {
      const { principal, catalogs, shared, rows, saveRow } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));
      await getSkillWithId(shared, catalogs[0], principal, 'dup');
      let started!: () => void;
      const writing = new Promise<void>((resolve) => (started = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      // A publish that has written its rows but not completed, as a crashed one leaves them.
      const stuck = catalogs[0].publishSkillRevision('dup', {
        fileCount: 1,
        write: async (number) => {
          await saveRow(`.skills/dup@${String(number)}/SKILL.md`, skillMd('pending'));
          started();
          await released;
          return undefined;
        },
      });
      await writing;

      expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toEqual({
        status: 204,
        body: null,
      });
      release();
      await expect(stuck).resolves.toBeNull();

      const left = (await catalogs[0].listFiles()).filter((row) => row.kind === 'file');
      expect(left).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][cli] aw skills push', async () => {
      const { principal, catalogs, shared, objects, rows, rowTexts } = await rowsWorld();
      const imported = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('A'),
        rows,
      );
      expect(imported.status).toBe(201);

      // The second push of `uploadSkill`: the new files, and the paths the new directory dropped.
      const pushed = await patchSkillWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        {
          files: [
            { path: 'SKILL.md', contentBase64: b64(skillMd('B')) },
            { path: 'references/new.md', contentBase64: b64('new') },
          ],
          removeFiles: ['scripts/run.sh'],
        },
        rows,
      );

      expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('B'),
        '.skills/dup/references/new.md': 'new',
      });
      expect(await objects.listPrefix('')).toHaveLength(2);
      expect(await walkFiles(shared, 'skills')).toEqual([]);
      expect((await catalogs[0].listSkills()).map((row) => row.skillMd)).toEqual([skillMd('B')]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a failing save leaves the previous version readable', async () => {
      let failFrom = Number.POSITIVE_INFINITY;
      let writes = 0;
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
        ...objects,
        write: (name, body, options) => {
          writes += 1;
          return writes >= failFrom
            ? Promise.reject(new Error('disk blip'))
            : objects.write(name, body, options);
        },
      }));
      const imported = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('A'),
        rows,
      );
      expect(imported.status).toBe(201);
      const before = await rowTexts('.skills/dup');

      failFrom = writes + 2;
      await expect(
        patchSkillWithId(
          shared,
          catalogs[0],
          principal,
          'dup',
          {
            files: [
              { path: 'SKILL.md', contentBase64: b64(skillMd('B')) },
              { path: 'references/a.md', contentBase64: b64('a') },
              { path: 'references/b.md', contentBase64: b64('b') },
            ],
            removeFiles: ['scripts/run.sh'],
          },
          rows,
        ),
      ).rejects.toThrow();

      const after = await rowTexts('.skills/dup');
      expect(after['.skills/dup/scripts/run.sh']).toBe(before['.skills/dup/scripts/run.sh']);
      expect(after['.skills/dup/SKILL.md']).toBeDefined();
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a failed import removes its rows and releases the name', async () => {
      let fail = true;
      let writes = 0;
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
        ...objects,
        write: (name, body, options) => {
          writes += 1;
          return fail && writes === 2
            ? Promise.reject(new Error('disk blip'))
            : objects.write(name, body, options);
        },
      }));

      await expect(
        importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows),
      ).rejects.toThrow();
      expect(await rowTexts('.skills/dup')).toEqual({});
      expect(await catalogs[0].listSkills()).toEqual([]);

      fail = false;
      const retried = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('B'),
        rows,
      );
      expect(retried.status).toBe(201);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('B'),
        '.skills/dup/scripts/run.sh': runSh('B'),
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a published revision is frozen as rows', async () => {
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
      const imported = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('A'),
        rows,
      );
      expect(imported.status).toBe(201);
      const publish = (who: string) =>
        publishSkillRevisionWithId(
          shared,
          catalogs[0],
          principal,
          'dup',
          { files: importBody(who).files },
          rows,
        );

      expect((await publish('A')).status).toBe(201);
      const first = await rowTexts('.skills/dup@1');
      expect(first).toEqual({
        '.skills/dup@1/SKILL.md': skillMd('A'),
        '.skills/dup@1/scripts/run.sh': runSh('A'),
      });
      await patchSkillWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: [{ path: 'SKILL.md', contentBase64: b64(skillMd('P')) }] },
        rows,
      );
      expect((await publish('C')).status).toBe(201);

      expect(await rowTexts('.skills/dup@1')).toEqual(first);
      expect(await rowTexts('.skills/dup@2')).toEqual({
        '.skills/dup@2/SKILL.md': skillMd('C'),
        '.skills/dup@2/scripts/run.sh': runSh('C'),
      });
      expect(await walkFiles(shared, 'skills')).toEqual([]);
      expect(await walkFiles(shared, 'skill-revisions')).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a publish clears the leftover rows of a crashed publish', async () => {
      const { principal, catalogs, shared, rows, rowTexts, saveRow } = await rowsWorld();
      const imported = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('A'),
        rows,
      );
      expect(imported.status).toBe(201);
      await saveRow('.skills/dup@1/stale.md', 'stale');

      const published = await publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: importBody('B').files },
        rows,
      );

      expect(published.status).toBe(201);
      expect(Object.keys(await rowTexts('.skills/dup@1')).sort()).toEqual([
        '.skills/dup@1/SKILL.md',
        '.skills/dup@1/scripts/run.sh',
      ]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] patching or publishing a legacy skill moves it into rows', async () => {
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));
      await getSkillWithId(shared, catalogs[0], principal, 'dup');

      const patched = await patchSkillWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: [{ path: 'references/more.md', contentBase64: b64('more') }] },
        rows,
      );

      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('old'),
        '.skills/dup/references/more.md': 'more',
        '.skills/dup/scripts/run.sh': runSh('old'),
      });
      expect(await getSkillWithId(shared, catalogs[0], principal, 'dup', rows)).toMatchObject({
        body: { skill: { fileCount: 3 } },
      });

      await seedBareSkill(shared, { ...importBody('x'), name: 'other' });
      await getSkillWithId(shared, catalogs[0], principal, 'other');
      const published = await publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'other',
        { files: [{ path: 'SKILL.md', contentBase64: b64(skillMd('pub')) }] },
        rows,
      );
      expect(published.status, JSON.stringify(published.body)).toBe(201);
      expect(Object.keys(await rowTexts('.skills/other'))).toEqual(['.skills/other/SKILL.md']);
      expect(Object.keys(await rowTexts('.skills/other@1'))).toEqual(['.skills/other@1/SKILL.md']);
      expect(await walkFiles(shared, 'skills')).toEqual([]);
    });

    const legacyBody = {
      name: 'dup',
      files: [
        { path: 'SKILL.md', contentBase64: b64(skillMd('old')) },
        { path: 'references/notes.md', contentBase64: b64('notes') },
        { path: 'scripts/run.sh', contentBase64: b64(runSh('old')) },
      ],
    };
    const addFile = (path: string, text: string) => ({
      files: [{ path, contentBase64: b64(text) }],
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a legacy move that fails part-way is resumed by the next patch', async () => {
      let failAt = Number.POSITIVE_INFINITY;
      let writes = 0;
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
        ...objects,
        write: (name, body, options) => {
          writes += 1;
          return writes === failAt
            ? Promise.reject(new Error('disk blip'))
            : objects.write(name, body, options);
        },
      }));
      await seedBareSkill(shared, legacyBody);
      await getSkillWithId(shared, catalogs[0], principal, 'dup');
      const patch = (body: unknown) =>
        patchSkillWithId(shared, catalogs[0], principal, 'dup', body, rows);

      failAt = 2;
      await expect(patch(addFile('references/new.md', 'new'))).rejects.toThrow('disk blip');
      expect(Object.keys(await rowTexts('.skills/dup'))).toEqual(['.skills/dup/SKILL.md']);

      const retried = await patch(addFile('references/new.md', 'new'));
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('old'),
        '.skills/dup/references/new.md': 'new',
        '.skills/dup/references/notes.md': 'notes',
        '.skills/dup/scripts/run.sh': runSh('old'),
      });
      expect(await walkFiles(shared, 'skills')).toEqual([]);

      // A file a patch removed after the move is never brought back.
      expect((await patch({ removeFiles: ['references/notes.md'] })).status).toBe(200);
      expect((await patch(addFile('references/later.md', 'later'))).status).toBe(200);
      expect(Object.keys(await rowTexts('.skills/dup')).sort()).toEqual([
        '.skills/dup/SKILL.md',
        '.skills/dup/references/later.md',
        '.skills/dup/references/new.md',
        '.skills/dup/scripts/run.sh',
      ]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] two concurrent first patches of one legacy skill both land', async () => {
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
      await seedBareSkill(shared, legacyBody);
      await getSkillWithId(shared, catalogs[0], principal, 'dup');

      const patched = await Promise.all([
        patchSkillWithId(shared, catalogs[0], principal, 'dup', addFile('a.md', 'a'), rows),
        patchSkillWithId(shared, catalogs[1], principal, 'dup', addFile('b.md', 'b'), rows),
      ]);

      expect(patched.map((result) => result.status)).toEqual([200, 200]);
      expect(await rowTexts('.skills/dup')).toEqual({
        '.skills/dup/SKILL.md': skillMd('old'),
        '.skills/dup/a.md': 'a',
        '.skills/dup/b.md': 'b',
        '.skills/dup/references/notes.md': 'notes',
        '.skills/dup/scripts/run.sh': runSh('old'),
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] more concurrent publishes than the pool has connections all finish', async () => {
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld(undefined, 1);
      const imported = await importSkillWithId(
        shared,
        catalogs[1],
        principal,
        importBody('A'),
        rows,
      );
      expect(imported.status).toBe(201);

      const published = await Promise.all(
        Array.from({ length: SECOND_POOL_SIZE + 1 }, (_, index) =>
          publishSkillRevisionWithId(
            shared,
            catalogs[1],
            principal,
            'dup',
            { files: importBody(`P${String(index)}`).files },
            rows,
          ),
        ),
      );

      expect(published.map((result) => result.status)).toEqual(
        Array.from({ length: SECOND_POOL_SIZE + 1 }, () => 201),
      );
      const numbers = published.map(
        (result) => (result.body as { revision: { number: number } }).revision.number,
      );
      const expected = Array.from({ length: SECOND_POOL_SIZE + 1 }, (_, index) => index + 1);
      expect([...numbers].sort((a, b) => a - b)).toEqual(expected);
      for (const number of numbers) {
        expect(Object.keys(await rowTexts(`.skills/dup@${String(number)}`))).toHaveLength(2);
      }
      const listed = await catalogs[1].listSkillRevisions('dup');
      expect(listed.map((revision) => revision.number)).toEqual([...expected].reverse());
    }, 60_000);

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a publish whose revision rows fail is never listed and its rows go', async () => {
      let fail = false;
      let writes = 0;
      const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
        ...objects,
        write: (name, body, options) => {
          writes += 1;
          return fail && writes % 2 === 0
            ? Promise.reject(new Error('disk blip'))
            : objects.write(name, body, options);
        },
      }));
      expect(
        (await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows)).status,
      ).toBe(201);
      const publish = () =>
        publishSkillRevisionWithId(
          shared,
          catalogs[0],
          principal,
          'dup',
          { files: importBody('B').files },
          rows,
        );

      // The current files take writes 1-2 and the revision's first row write 3; write 4 fails.
      fail = true;
      writes = -1;
      await expect(publish()).rejects.toThrow('disk blip');
      expect(await catalogs[0].listSkillRevisions('dup')).toEqual([]);
      expect(await rowTexts('.skills/dup@1')).toEqual({});

      fail = false;
      expect(await publish()).toMatchObject({ status: 201, body: { revision: { number: 1 } } });
    });

    // @story US-STO-08
    it.each([
      ['upload_in_progress', 409],
      ['path_taken', 409],
      ['too_large', 413],
    ] as const)('[US-STO-08][api][sdk] a save refused as %s answers %i', async (code, status) => {
      const { principal, catalogs, shared, rows, storage } = await rowsWorld();
      const refusing: SkillRowsAccess = {
        ...rows,
        storage: { ...storage, save: () => Promise.resolve({ ok: false, code }) },
      };
      expect(
        await importSkillWithId(shared, catalogs[0], principal, importBody('A'), refusing),
      ).toMatchObject({ status, body: { error: { code } } });
      expect(await catalogs[0].listSkills()).toEqual([]);

      expect(
        (await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows)).status,
      ).toBe(201);
      expect(
        await patchSkillWithId(
          shared,
          catalogs[0],
          principal,
          'dup',
          addFile('a.md', 'a'),
          refusing,
        ),
      ).toMatchObject({ status, body: { error: { code } } });
      expect(
        await publishSkillRevisionWithId(
          shared,
          catalogs[0],
          principal,
          'dup',
          { files: importBody('B').files },
          refusing,
        ),
      ).toMatchObject({ status, body: { error: { code } } });
      expect(await catalogs[0].listSkillRevisions('dup')).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a delete interrupted after the row is marked resumes and removes the revision rows', async () => {
      let failRemove = false;
      const { principal, catalogs, shared, rows, rowTexts, storage } = await rowsWorld();
      const flaky: SkillRowsAccess = {
        ...rows,
        storage: {
          ...storage,
          remove: (ctx, area, path, options) =>
            failRemove
              ? Promise.reject(new Error('blip'))
              : storage.remove(ctx, area, path, options),
        },
      };
      const imported = await importSkillWithId(
        shared,
        catalogs[0],
        principal,
        importBody('A'),
        rows,
      );
      expect(imported.status).toBe(201);
      const publish = () =>
        publishSkillRevisionWithId(
          shared,
          catalogs[0],
          principal,
          'dup',
          { files: importBody('A').files },
          rows,
        );
      await publish();
      await publish();

      failRemove = true;
      await expect(deleteSkill(shared, catalogs[0], 'dup', flaky)).rejects.toThrow('blip');
      expect(await catalogs[0].listSkills()).toMatchObject([
        { name: 'dup', pendingDelete: { revisions: [1, 2] } },
      ]);
      failRemove = false;
      expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({ status: 204 });

      expect((await catalogs[0].listFiles()).filter((row) => row.kind === 'file')).toEqual([]);

      const again = await importSkillWithId(shared, catalogs[0], principal, importBody('N'), rows);
      expect(again.status).toBe(201);
      expect((await publish()).status).toBe(201);
      expect(Object.keys(await rowTexts('.skills/dup@1')).sort()).toEqual([
        '.skills/dup@1/SKILL.md',
        '.skills/dup@1/scripts/run.sh',
      ]);
      expect(await rowTexts('.skills/dup@2')).toEqual({});
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a built-in install saves its files as rows', async () => {
      const { principal, catalogs, shared, rows, storage } = await rowsWorld();
      const name = 'office-reader';

      await ensureBuiltinSkills(shared, catalogs[0], principal, [name], rows);

      const listed = await storage.list(
        { workspaceId: principal.workspaceId },
        'skills',
        `.skills/${name}`,
      );
      expect(listed.rows.map((row) => row.path.slice(`.skills/${name}/`.length)).sort()).toEqual(
        builtinSkillFiles(name)
          .map((file) => file.path)
          .sort(),
      );
      expect(await walkFiles(shared, 'skills')).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a skill in use keeps its catalog rows', async () => {
      const { principal, catalogs, assign, shared, rows, saveRow } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));
      await getSkillWithId(shared, catalogs[0], principal, 'dup');
      await saveRow('.skills/dup/SKILL.md', skillMd('rows'));
      await assign('dup');

      expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({
        status: 409,
        body: { error: { code: 'skill_in_use' } },
      });
      expect((await catalogs[0].listFiles()).map((row) => row.path)).toContain(
        '.skills/dup/SKILL.md',
      );
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] delete of a legacy skill still removes its prefix', async () => {
      const { principal, catalogs, shared, rows } = await rowsWorld();
      await seedBareSkill(shared, importBody('old'));
      await getSkillWithId(shared, catalogs[0], principal, 'dup');

      expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({ status: 204 });

      expect(await walkFiles(shared, 'skills')).toEqual([]);
      expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({ status: 404 });
    });
  });
}

defineSuite('in-memory catalog', memoryFixture, true);
defineSuite('PostgreSQL catalog', postgresFixture, hasDatabase);
