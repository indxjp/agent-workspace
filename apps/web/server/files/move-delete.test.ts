/**
 * `PATCH` and `DELETE /api/files/:id` over the catalog service (the storage design, §06 Phase 3
 * "Done when", §04 "File states", §05): a rename or move updates rows and copies no object, and a
 * delete removes the stored object, not only the row. Driven with real `Request` objects on the
 * in-memory catalog and on PostgreSQL.
 */
// @story US-STO-03
// @story US-STO-04
import { MoveFileResponseSchema } from '@indx-workspace/contracts/files';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DELETE as deleteRoute,
  GET as downloadRoute,
  PATCH as patchRoute,
} from '../../app/api/files/[id]/route';
import { POST as uploadRoute } from '../../app/api/files/route';
import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  files,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  storageObjectName,
  type ObjectStoreProviderV2,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { Principal } from '../rbac/principal';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { encodeFileId } from './file-id';
import { createRepositoryObjectStoreProvider } from './store';

const ACTOR_HEADER = 'x-test-actor';
const FOLDER_FILES = 10_000;

type Actor = 'owner' | 'builder' | 'viewer';

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  /**
   * Ready file rows with an object id and no object behind them, written straight into the catalog
   * (one bulk insert on PostgreSQL), like a raw insert: the folder move is the thing under test,
   * not 10,000 uploads.
   */
  seed(paths: readonly string[]): Promise<void>;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function memoryWorld(): Promise<World> {
  const a = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  const catalogs = createInMemoryCatalogStore();
  return Promise.resolve({
    catalogs,
    scopes: createInMemoryWorkspaceScopeResolver([{ id: a.workspaceId, slug: 'acme' }]),
    a,
    seed: (paths) => {
      const catalog = catalogs.forWorkspaceSync(a.workspaceId);
      for (const path of paths) {
        catalog.seed({
          path,
          status: 'ready',
          ownerPrincipalId: a.principalId,
          objectId: crypto.randomUUID(),
        });
      }
      return Promise.resolve();
    },
  });
}

let isolated: IsolatedTestDatabase | undefined;

async function postgresMember(db: IsolatedTestDatabase['db']): Promise<Member> {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'files' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  return { workspaceId, principalId, userId };
}

async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const { db } = isolated;
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  const a = await postgresMember(db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes,
    }),
    scopes,
    a,
    seed: async (paths) => {
      const rows = paths.map((path) => {
        const objectId = crypto.randomUUID();
        return {
          workspaceId: a.workspaceId,
          path,
          kind: 'file' as const,
          storageKey: `files/${objectId}`,
          objectId,
          sizeBytes: 1,
          contentType: 'text/plain',
          ownerPrincipalId: a.principalId,
          createdBy: a.userId,
        };
      });
      for (let at = 0; at < rows.length; at += 2000) {
        await db.insert(files).values(rows.slice(at, at + 2000));
      }
    },
  };
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  }
  isolated = await createIsolatedTestDatabase('aw_files_move_delete');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(() => {
  clearApplicationContext();
});

/** Counts every call that would write or copy bytes. */
function counting(store: ObjectStoreV2, calls: { writes: number }): ObjectStoreV2 {
  return {
    ...store,
    put: (...args) => {
      calls.writes += 1;
      return store.put(...args);
    },
    write: (...args) => {
      calls.writes += 1;
      return store.write(...args);
    },
    copyObject: (...args) => {
      calls.writes += 1;
      return store.copyObject(...args);
    },
  };
}

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`move and delete on the ${name}`, () => {
    let world: World;
    let storage: StorageService;
    const calls = { writes: 0 };
    const rawLegacy = createInMemoryObjectStoreProvider();
    const legacy: ObjectStoreProviderV2 = {
      forWorkspace: (workspaceId) => counting(rawLegacy.forWorkspace(workspaceId), calls),
    };
    let objects: ObjectStoreV2;
    // Another member of the same workspace, and a read-only one: neither owns the seeded files.
    const builderId = crypto.randomUUID();
    const viewerId = crypto.randomUUID();

    beforeEach(async () => {
      world = await setup();
      calls.writes = 0;
      objects = counting(createInMemoryObjectStore(), calls);
      storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects,
        legacy: { files: legacy },
        log: noLog,
      });
      const principalFor = (actor: Actor): Principal =>
        Principal.fromApiKey({
          principalId:
            actor === 'owner' ? world.a.principalId : actor === 'builder' ? builderId : viewerId,
          apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workspaceId: world.a.workspaceId,
          role: actor,
          label: 'Move and delete test key',
        });
      installTestDomains({
        files: {
          kind: 'serving',
          runtime: {
            store: createRepositoryObjectStoreProvider({ store: legacy, scopes: world.scopes }),
            catalog: world.catalogs,
            storage,
            resolveWorkspace: () =>
              Promise.resolve({ kind: 'workspace', workspaceId: world.a.workspaceId }),
          },
        },
        rbac: {
          directory: createMemoryDirectory({
            users: [
              {
                email: `owner-${world.a.workspaceId}@example.test`,
                name: 'Owner',
                workspaceId: world.a.workspaceId,
                role: 'owner' as const,
              },
            ],
          }),
          identify: (request: Request) =>
            Promise.resolve(principalFor((request.headers.get(ACTOR_HEADER) ?? 'owner') as Actor)),
        },
      });
    });

    const ctx = (): StorageContext => ({
      workspaceId: world.a.workspaceId,
      principalId: world.a.principalId,
      userId: world.a.userId,
    });

    async function save(path: string, text: string) {
      const saved = await storage.save(ctx(), {
        area: 'files',
        path,
        maxBytes: 1024,
        replace: true,
        body: bytesToStream(bytesOf(text)),
      });
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      return saved.row;
    }

    /** A ready row in the old naming: `objectId` null, the bytes at the path in the area store. */
    async function saveLegacy(path: string, text: string) {
      await rawLegacy.forWorkspace(world.a.workspaceId).write(path, bytesOf(text), {});
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      const reserved = await catalog.reserve(path, {
        ownerPrincipalId: world.a.principalId,
        sizeBytes: bytesOf(text).byteLength,
        contentType: 'text/plain',
      });
      const confirmed = await catalog.confirm(reserved.row, {
        sizeBytes: bytesOf(text).byteLength,
        contentType: 'text/plain',
      });
      if (confirmed === null) throw new Error('the legacy row did not confirm');
      return confirmed.row;
    }

    const params = (path: string) => ({ params: Promise.resolve({ id: encodeFileId(path) }) });
    const url = (path: string) => `https://example.invalid/api/files/${encodeFileId(path)}`;

    const download = (path: string, actor: Actor = 'owner') =>
      downloadRoute(new Request(url(path), { headers: { [ACTOR_HEADER]: actor } }), params(path));

    const move = (path: string, newPath: string, actor: Actor = 'owner') =>
      patchRoute(
        new Request(url(path), {
          method: 'PATCH',
          headers: { [ACTOR_HEADER]: actor, 'content-type': 'application/json' },
          body: JSON.stringify({ newPath }),
        }),
        params(path),
      );

    const remove = (path: string, options: { recursive?: boolean; actor?: Actor } = {}) =>
      deleteRoute(
        new Request(`${url(path)}${options.recursive === true ? '?recursive=true' : ''}`, {
          method: 'DELETE',
          headers: { [ACTOR_HEADER]: options.actor ?? 'owner' },
        }),
        params(path),
      );

    /**
     * `count` ready files under `folder`, seeded in bulk. Seeding them through `reserve` and
     * `confirm` was 20,000 transactions, serialised because every `reserve` locks the shared parent
     * folder's path: about 63 s of this test's 64 s on a 2-CPU PostgreSQL, and past the 180 s
     * timeout on a GitHub-hosted runner, while the move itself took 0.3 s.
     */
    async function seedRows(folder: string, count: number): Promise<void> {
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      await catalog.createFolder(folder, { ownerPrincipalId: world.a.principalId });
      await world.seed(
        Array.from({ length: count }, (_, index) => `${folder}/f-${String(index)}.txt`),
      );
    }

    // @story US-STO-03
    it('[US-STO-03][api][sdk] moving a folder copies no files', async () => {
      await save('big/keep.txt', 'kept');
      await seedRows('big', FOLDER_FILES - 1);
      calls.writes = 0;

      const response = await move('big', 'archive/big');

      expect(response.status, await response.clone().text()).toBe(200);
      // The folder row moves with its files.
      expect(await response.json()).toEqual({ status: 'ok', moved: FOLDER_FILES + 1 });
      expect(calls.writes).toBe(0);
      const moved = await download('archive/big/keep.txt');
      expect(moved.status).toBe(200);
      expect(await moved.text()).toBe('kept');
      expect((await download('big/keep.txt')).status).toBe(404);
    }, 180_000);

    // @story US-STO-03
    it('[US-STO-03][api][sdk] renaming a file keeps its row and copies nothing', async () => {
      const row = await save('docs/a.txt', 'alpha');
      calls.writes = 0;

      const response = await move('docs/a.txt', 'docs/b.txt');

      expect(response.status, await response.clone().text()).toBe(200);
      const body = MoveFileResponseSchema.parse(await response.json());
      expect(body).toMatchObject({ file: { id: row.id, path: 'docs/b.txt', kind: 'file' } });
      expect(calls.writes).toBe(0);
      expect(await (await download('docs/b.txt')).text()).toBe('alpha');
      expect((await download('docs/a.txt')).status).toBe(404);
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] a rename onto an existing file answers name_conflict', async () => {
      await save('docs/a.txt', 'alpha');
      await save('docs/b.txt', 'beta');

      const response = await move('docs/a.txt', 'docs/b.txt');

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'name_conflict' } });
      expect(await (await download('docs/a.txt')).text()).toBe('alpha');
      expect(await (await download('docs/b.txt')).text()).toBe('beta');
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] a rename of a missing path answers file_not_found', async () => {
      const response = await move('docs/missing.txt', 'docs/b.txt');

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'file_not_found' } });
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] a rename onto a pending upload answers upload_in_progress', async () => {
      await save('docs/a.txt', 'alpha');
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      await catalog.reserve('docs/pending.txt', {
        ownerPrincipalId: world.a.principalId,
        sizeBytes: 1,
        contentType: null,
        objectId: crypto.randomUUID(),
        area: 'files',
      });

      const response = await move('docs/a.txt', 'docs/pending.txt');

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
      expect((await download('docs/a.txt')).status).toBe(200);
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] an unsafe destination answers invalid_path', async () => {
      await save('docs/a.txt', 'alpha');

      const response = await move('docs/a.txt', 'docs/../../escape.txt');

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_path' } });
      expect((await download('docs/a.txt')).status).toBe(200);
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] a folder cannot move into itself', async () => {
      await save('docs/a.txt', 'alpha');

      const response = await move('docs', 'docs/inner');

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'self_descendant' } });
      expect((await download('docs/a.txt')).status).toBe(200);
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] a rename onto the same path is a no-op', async () => {
      const row = await save('docs/a.txt', 'alpha');
      calls.writes = 0;

      const file = await move('docs/a.txt', 'docs/a.txt');
      expect(file.status, await file.clone().text()).toBe(200);
      expect(await file.json()).toMatchObject({ file: { id: row.id, path: 'docs/a.txt' } });

      const folder = await move('docs', 'docs');
      expect(folder.status, await folder.clone().text()).toBe(200);
      expect(await folder.json()).toEqual({ status: 'ok', moved: 0 });

      expect(calls.writes).toBe(0);
      expect(await (await download('docs/a.txt')).text()).toBe('alpha');
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] a renamed legacy row still downloads and its old key is gone', async () => {
      await saveLegacy('old/report.txt', 'old bytes');

      const response = await move('old/report.txt', 'new/report.txt');

      expect(response.status, await response.clone().text()).toBe(200);
      const download2 = await download('new/report.txt');
      expect(download2.status).toBe(200);
      expect(await download2.text()).toBe('old bytes');
      expect((await download('old/report.txt')).status).toBe(404);
      expect(await rawLegacy.forWorkspace(world.a.workspaceId).head('old/report.txt')).toBeNull();
    });

    /**
     * Independent races run side by side, each in its own folder: one pair of requests alone often
     * finishes its first transaction before the second starts, and then races nothing.
     */
    const raceFolders = Array.from({ length: 5 }, (_, index) => `race-${String(index)}`);

    /** Two files per folder renamed onto one destination: one 200, one 409, both still download. */
    async function expectRenameRacesSettle(seed: (path: string, text: string) => Promise<unknown>) {
      const races = raceFolders.map((folder) => ({
        destination: `${folder}/same.txt`,
        files: [
          { path: `${folder}/a.txt`, text: `alpha ${folder}` },
          { path: `${folder}/b.txt`, text: `beta ${folder}` },
        ],
      }));
      for (const race of races) for (const file of race.files) await seed(file.path, file.text);

      const responses = await Promise.all(
        races.map((race) =>
          Promise.all(race.files.map((file) => move(file.path, race.destination))),
        ),
      );

      for (const [at, race] of races.entries()) {
        const pair = responses[at] ?? [];
        expect(pair.map((response) => response.status).sort()).toEqual([200, 409]);
        const loser = pair.find((response) => response.status === 409);
        expect(await loser?.json()).toMatchObject({ error: { code: 'name_conflict' } });
        const winner = pair[0]?.status === 200 ? 0 : 1;
        for (const [index, file] of race.files.entries()) {
          const path = index === winner ? race.destination : file.path;
          const response = await download(path);
          expect(response.status, path).toBe(200);
          expect(await response.text()).toBe(file.text);
        }
      }
      const rows = await (await world.catalogs.forWorkspace(world.a.workspaceId)).listFiles();
      expect(rows.filter((row) => row.kind === 'file')).toHaveLength(races.length * 2);
    }

    // @story US-STO-03
    it('[US-STO-03][api][sdk] two concurrent renames of legacy-naming rows onto one destination: one 200, one 409, both files still download', () =>
      expectRenameRacesSettle(saveLegacy));

    // @story US-STO-03
    it('[US-STO-03][api][sdk] two concurrent renames onto one destination: one 200, one 409, both files still download', () =>
      expectRenameRacesSettle(save));

    // @story US-STO-03
    it('[US-STO-03][api][sdk] a rename racing an upload to its destination: the upload lands, the rename lands first or answers 409, nothing is lost', async () => {
      for (const folder of raceFolders) await save(`${folder}/a.txt`, 'alpha');

      const responses = await Promise.all(
        raceFolders.map((folder) =>
          Promise.all([
            move(`${folder}/a.txt`, `${folder}/x.txt`),
            uploadRoute(
              new Request('https://example.invalid/api/files', {
                method: 'POST',
                body: 'uploaded',
                headers: { [ACTOR_HEADER]: 'owner', 'x-file-path': `${folder}/x.txt` },
              }),
            ),
          ]),
        ),
      );

      const expectedPaths: string[] = [];
      for (const [at, folder] of raceFolders.entries()) {
        const [renamed, uploaded] = responses[at] ?? [];
        if (renamed === undefined || uploaded === undefined)
          throw new Error('a request is missing');
        // An upload replaces a ready file, so a rename that commits first is then replaced; one
        // that comes second meets the upload's row and refuses.
        expect(uploaded.status, await uploaded.clone().text()).toBe(201);
        expect([200, 409]).toContain(renamed.status);
        if (renamed.status === 409) {
          const { error } = (await renamed.json()) as { error: { code: string } };
          expect(['name_conflict', 'upload_in_progress']).toContain(error.code);
        }
        expect(await (await download(`${folder}/x.txt`)).text()).toBe('uploaded');
        const source = await download(`${folder}/a.txt`);
        if (renamed.status === 200) {
          expect(source.status).toBe(404);
        } else {
          expect(await source.text()).toBe('alpha');
          expectedPaths.push(`${folder}/a.txt`);
        }
        expectedPaths.push(`${folder}/x.txt`);
      }
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      expect(await catalog.countPending()).toBe(0);
      const rows = (await catalog.listFiles()).filter((row) => row.kind === 'file');
      expect(rows.map((row) => row.path).sort()).toEqual(expectedPaths.sort());
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] delete removes the stored object', async () => {
      const row = await save('docs/a.txt', 'alpha');
      if (row.objectId === null || row.objectId === undefined) throw new Error('no object id');
      const name = storageObjectName(world.a.workspaceId, 'files', row.objectId);
      expect(await objects.head(name)).not.toBeNull();

      const response = await remove('docs/a.txt');

      expect(response.status).toBe(204);
      expect(await objects.head(name)).toBeNull();
      expect((await download('docs/a.txt')).status).toBe(404);
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      expect(await catalog.get('docs/a.txt')).toBeNull();
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] a folder with files needs recursive, and recursive removes every object', async () => {
      const first = await save('docs/a.txt', 'alpha');
      const second = await save('docs/sub/b.txt', 'beta');
      const names = [first, second].map((row) =>
        storageObjectName(world.a.workspaceId, 'files', row.objectId ?? ''),
      );

      const refused = await remove('docs');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'folder_not_empty' } });
      for (const name of names) expect(await objects.head(name)).not.toBeNull();

      const response = await remove('docs', { recursive: true });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ok',
        deleted: ['docs/a.txt', 'docs/sub/b.txt'],
      });
      for (const name of names) expect(await objects.head(name)).toBeNull();
      expect((await download('docs/a.txt')).status).toBe(404);
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] an empty folder deletes without recursive', async () => {
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      await catalog.createFolder('empty', { ownerPrincipalId: world.a.principalId });

      const response = await remove('empty');

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', deleted: [] });
      expect(await catalog.get('empty')).toBeNull();
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] deleting a path that is not there answers 204', async () => {
      expect((await remove('docs/missing.txt')).status).toBe(204);
    });

    // @story US-STO-03
    // @story US-STO-04
    it('[US-STO-03][api][sdk] a member cannot move or delete another member’s file, and a viewer cannot at all', async () => {
      const row = await save('docs/a.txt', 'alpha');
      const name = storageObjectName(world.a.workspaceId, 'files', row.objectId ?? '');
      calls.writes = 0;

      for (const actor of ['builder', 'viewer'] as const) {
        expect((await move('docs/a.txt', 'docs/b.txt', actor)).status).toBe(403);
        expect((await remove('docs/a.txt', { actor })).status).toBe(403);
        expect((await move('docs', 'elsewhere', actor)).status).toBe(403);
        expect((await remove('docs', { actor, recursive: true })).status).toBe(403);
      }

      expect(calls.writes).toBe(0);
      expect(await objects.head(name)).not.toBeNull();
      expect(await (await download('docs/a.txt')).text()).toBe('alpha');
    });
  });
}

defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
