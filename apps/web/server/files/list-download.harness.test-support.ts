import { beforeEach, expect } from 'vitest';
import { GET as listRoute } from '../../app/api/files/route';
import { GET as downloadRoute } from '../../app/api/files/[id]/route';

import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { FileResourceSchema } from '@indx-workspace/contracts/files';
import { installTestDomains } from '../application-context-fixtures';
import { Principal } from '../rbac/principal';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { encodeFileId } from './file-id';
import { createRepositoryObjectStoreProvider } from './store';
import {
  ACTOR_HEADER,
  type Member,
  type World,
  noLog,
  bytesOf,
} from './list-download.fixture.test-support';
export function createFileReadFixture(setup: () => Promise<World>) {
  let world: World;
  let objects: ObjectStore;
  let storage: StorageService;
  const legacy = createInMemoryObjectStoreProvider();
  function install(root: ObjectStore): void {
    objects = root;
    storage = createStorageService({
      catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
      objects,
      log: noLog,
    });
    const principals = new Map([
      ['a', world.a],
      ['b', world.b],
    ]);
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
          users: [world.a, world.b].map((member) => ({
            email: `owner-${member.workspaceId}@example.test`,
            name: 'Owner',
            workspaceId: member.workspaceId,
            role: 'owner' as const,
          })),
        }),
        identify: (request: Request) => {
          const member = principals.get(request.headers.get(ACTOR_HEADER) ?? 'a');
          return Promise.resolve(
            member === undefined
              ? null
              : Principal.fromApiKey({
                  principalId: member.principalId,
                  apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  workspaceId: member.workspaceId,
                  role: 'owner',
                  label: 'List and download test key',
                }),
          );
        },
      },
    });
  }
  beforeEach(async () => {
    world = await setup();
    install(createInMemoryObjectStore());
  });
  const ctxOf = (member: Member): StorageContext => ({
    workspaceId: member.workspaceId,
    principalId: member.principalId,
    userId: member.userId,
  });
  async function save(path: string, text: string) {
    const saved = await storage.save(ctxOf(world.a), {
      area: 'files',
      path,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(bytesOf(text)),
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    return saved.row;
  }
  const list = (actor: 'a' | 'b', path?: string) =>
    listRoute(
      new Request(
        `https://example.invalid/api/files${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`,
        { headers: { [ACTOR_HEADER]: actor } },
      ),
    );
  const download = (actor: 'a' | 'b', path: string) =>
    downloadRoute(
      new Request(`https://example.invalid/api/files/${encodeFileId(path)}`, {
        headers: { [ACTOR_HEADER]: actor },
      }),
      { params: Promise.resolve({ id: encodeFileId(path) }) },
    );
  async function listed(actor: 'a' | 'b', path?: string) {
    const response = await list(actor, path);
    expect(response.status, await response.clone().text()).toBe(200);
    const { files } = (await response.json()) as { files: unknown[] };
    return files.map((file) => FileResourceSchema.parse(file));
  }
  return {
    get world() {
      return world;
    },
    get objects() {
      return objects;
    },
    get storage() {
      return storage;
    },
    get legacy() {
      return legacy;
    },
    get install() {
      return install;
    },
    get ctxOf() {
      return ctxOf;
    },
    get save() {
      return save;
    },
    get list() {
      return list;
    },
    get download() {
      return download;
    },
    get listed() {
      return listed;
    },
  };
}
export type FileReadFixture = ReturnType<typeof createFileReadFixture>;
