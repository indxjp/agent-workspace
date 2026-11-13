import { listCatalogFiles } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  storageObjectName,
  type ObjectStore,
  type ObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { afterEach, beforeEach, expect } from 'vitest';
import {
  DELETE as deleteRoute,
  GET as downloadRoute,
  PATCH as patchRoute,
} from '../../app/api/files/[id]/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { encodeFileId } from './file-id';
import type { World } from './move-delete.worlds.test-support';
import { createRepositoryObjectStoreProvider } from './store';
export const ACTOR_HEADER = 'x-test-actor';

export const FOLDER_FILES = 10_000;

type Actor = 'owner' | 'builder' | 'viewer';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => {
  clearApplicationContext();
});

function counting<S extends ObjectStore>(store: S, calls: { writes: number }): S {
  return {
    ...store,
    write: (...args) => {
      calls.writes += 1;
      return store.write(...args);
    },
    copy: (...args) => {
      calls.writes += 1;
      return store.copy(...args);
    },
  };
}

export {
  initializeDatabase,
  memoryWorld,
  postgresWorld,
  type World,
} from './move-delete.worlds.test-support';

export function createMoveDeleteFixture(setup: () => Promise<World>) {
  return new MoveDeleteFixture(setup);
}

class MoveDeleteFixture {
  constructor(private readonly setup: () => Promise<World>) {
    beforeEach(() => this.reset());
  }

  private worldValue: World | undefined;
  get world(): World {
    if (this.worldValue === undefined) throw new Error('fixture world not initialized');
    return this.worldValue;
  }

  private storageValue: StorageService | undefined;
  get storage(): StorageService {
    if (this.storageValue === undefined) throw new Error('fixture storage not initialized');
    return this.storageValue;
  }

  calls = { writes: 0 };

  private rawLegacy = createInMemoryObjectStoreProvider();

  private legacy: ObjectStoreProvider = {
    forWorkspace: (workspaceId) => counting(this.rawLegacy.forWorkspace(workspaceId), this.calls),
  };

  private objectsValue: ObjectStore | undefined;
  get objects(): ObjectStore {
    if (this.objectsValue === undefined) throw new Error('fixture objects not initialized');
    return this.objectsValue;
  }

  // Another member of the same workspace, and a read-only one: neither owns the seeded files.
  builderId = crypto.randomUUID();

  private viewerId = crypto.randomUUID();

  // Runs inside the service's `remove`, just before the catalog marks rows.
  hooks: { beforeRemove: () => Promise<unknown> } = {
    beforeRemove: () => Promise.resolve(),
  };

  private async reset() {
    this.worldValue = await this.setup();
    this.builderId = await this.world.member();
    this.calls.writes = 0;
    this.hooks.beforeRemove = () => Promise.resolve();
    this.objectsValue = counting(createInMemoryObjectStore(), this.calls);
    this.storageValue = createStorageService({
      catalog: async (workspaceId) => {
        const catalog = await this.world.catalogs.forWorkspace(workspaceId);
        return {
          ...catalog,
          remove: async (...args) => {
            await this.hooks.beforeRemove();
            return catalog.remove(...args);
          },
        };
      },
      objects: this.objects,
      log: noLog,
    });
    this.installDomains();
  }

  private principalFor(actor: Actor): Principal {
    return Principal.fromApiKey({
      principalId:
        actor === 'owner'
          ? this.world.a.principalId
          : actor === 'builder'
            ? this.builderId
            : this.viewerId,
      apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId: this.world.a.workspaceId,
      role: actor,
      label: 'Move and delete test key',
    });
  }

  private installDomains() {
    installTestDomains({
      files: {
        kind: 'serving',
        runtime: {
          store: createRepositoryObjectStoreProvider({
            store: this.legacy,
            scopes: this.world.scopes,
          }),
          catalog: this.world.catalogs,
          storage: this.storage,
          resolveWorkspace: () =>
            Promise.resolve({ kind: 'workspace', workspaceId: this.world.a.workspaceId }),
        },
      },
      rbac: {
        directory: createMemoryDirectory({
          users: [
            {
              email: `owner-${this.world.a.workspaceId}@example.test`,
              name: 'Owner',
              workspaceId: this.world.a.workspaceId,
              role: 'owner' as const,
            },
          ],
        }),
        identify: (request: Request) =>
          Promise.resolve(
            this.principalFor((request.headers.get(ACTOR_HEADER) ?? 'owner') as Actor),
          ),
      },
    });
  }

  ctx = (): StorageContext => ({
    workspaceId: this.world.a.workspaceId,
    principalId: this.world.a.principalId,
    userId: this.world.a.userId,
  });

  save = async (path: string, text: string) => {
    const saved = await this.storage.save(this.ctx(), {
      area: 'files',
      path,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(bytesOf(text)),
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    return saved.row;
  };

  private params = (path: string) => ({ params: Promise.resolve({ id: encodeFileId(path) }) });

  private url = (path: string) => `https://example.invalid/api/files/${encodeFileId(path)}`;

  download = (path: string, actor: Actor = 'owner') =>
    downloadRoute(
      new Request(this.url(path), { headers: { [ACTOR_HEADER]: actor } }),
      this.params(path),
    );

  move = (path: string, newPath: string, actor: Actor = 'owner') =>
    patchRoute(
      new Request(this.url(path), {
        method: 'PATCH',
        headers: { [ACTOR_HEADER]: actor, 'content-type': 'application/json' },
        body: JSON.stringify({ newPath }),
      }),
      this.params(path),
    );

  remove = (path: string, options: { recursive?: boolean; actor?: Actor } = {}) =>
    deleteRoute(
      new Request(`${this.url(path)}${options.recursive === true ? '?recursive=true' : ''}`, {
        method: 'DELETE',
        headers: { [ACTOR_HEADER]: options.actor ?? 'owner' },
      }),
      this.params(path),
    );

  /**
   * `count` ready files under `folder`, seeded in bulk. Seeding them through `reserve` and
   * `confirm` was 20,000 transactions, serialised because every `reserve` locks the shared parent
   * folder's path: about 63 s of this test's 64 s on a 2-CPU PostgreSQL, and past the 180 s
   * timeout on a GitHub-hosted runner, while the move itself took 0.3 s.
   */
  async seedRows(folder: string, count: number): Promise<void> {
    const catalog = await this.world.catalogs.forWorkspace(this.world.a.workspaceId);
    await catalog.createFolder(folder, { ownerPrincipalId: this.world.a.principalId });
    await this.world.seed(
      Array.from({ length: count }, (_, index) => `${folder}/f-${String(index)}.txt`),
    );
  }

  /**
   * Independent races run side by side, each in its own folder: one pair of requests alone often
   * finishes its first transaction before the second starts, and then races nothing.
   */
  raceFolders = Array.from({ length: 5 }, (_, index) => `race-${String(index)}`);

  /** Two files per folder renamed onto one destination: one 200, one 409, both still download. */
  async expectRenameRacesSettle(seed: (path: string, text: string) => Promise<unknown>) {
    const races = this.raceFolders.map((folder) => ({
      destination: `${folder}/same.txt`,
      files: [
        { path: `${folder}/a.txt`, text: `alpha ${folder}` },
        { path: `${folder}/b.txt`, text: `beta ${folder}` },
      ],
    }));
    for (const race of races) for (const file of race.files) await seed(file.path, file.text);

    const responses = await Promise.all(
      races.map((race) =>
        Promise.all(race.files.map((file) => this.move(file.path, race.destination))),
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
        const response = await this.download(path);
        expect(response.status, path).toBe(200);
        expect(await response.text()).toBe(file.text);
      }
    }
    const rows = await listCatalogFiles(
      await this.world.catalogs.forWorkspace(this.world.a.workspaceId),
    );
    expect(rows.filter((row) => row.kind === 'file')).toHaveLength(races.length * 2);
  }

  /** A signed upload reserved by `owner` at `path`, its bytes already in the object store. */
  async pendingUpload(owner: string, path: string): Promise<string> {
    const catalog = await this.world.catalogs.forWorkspace(this.world.a.workspaceId);
    const objectId = crypto.randomUUID();
    const reserved = await catalog.reserve(path, {
      ownerPrincipalId: owner,
      sizeBytes: 5,
      contentType: 'text/plain',
      objectId,
      uploadMode: 'signed',
    });
    if (reserved.kind !== 'reserved') throw new Error(`${path} was already taken`);
    const name = storageObjectName(this.world.a.workspaceId, 'files', objectId);
    await this.objects.write(name, bytesOf('hello'), { contentType: 'text/plain' });
    return name;
  }
}
