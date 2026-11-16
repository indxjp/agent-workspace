import { beforeEach } from 'vitest';
import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';

import {
  workspaceFolder,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { installTestDomains } from '../application-context-fixtures';
import { Principal } from '../rbac/principal';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { createStorageService } from '../storage/service';
import { createRepositoryObjectStoreProvider } from './store';
import {
  ACTOR_HEADER,
  type Actor,
  type Member,
  type World,
  noLog,
} from './upload-route.fixture.test-support';
export function createFileUploadFixture(setup: () => Promise<World>) {
  let world: World;
  let objects: ObjectStore;
  const legacy = createInMemoryObjectStoreProvider();
  function install(root: ObjectStore): void {
    objects = root;
    const storage = createStorageService({
      catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
      objects,
      log: noLog,
    });
    const principals: Record<Actor, { member: Member; role: 'owner' | 'viewer' | 'admin' }> = {
      a: { member: world.a, role: 'owner' },
      v: { member: { ...world.a, principalId: crypto.randomUUID() }, role: 'viewer' },
      c: { member: { ...world.a, principalId: crypto.randomUUID() }, role: 'admin' },
      b: { member: world.b, role: 'owner' },
    };
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
          const actor = principals[(request.headers.get(ACTOR_HEADER) ?? 'a') as Actor];
          return Promise.resolve(
            Principal.fromApiKey({
              principalId: actor.member.principalId,
              apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              workspaceId: actor.member.workspaceId,
              role: actor.role,
              label: 'Upload route test key',
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
  const post = (
    path: string,
    body: Uint8Array | ReadableStream<Uint8Array> | null,
    actor: Actor = 'a',
    headers: Record<string, string> = {},
  ) => {
    // A variable, not a literal: the DOM `RequestInit` has no `duplex`.
    const init = {
      method: 'POST',
      headers: { [ACTOR_HEADER]: actor, 'x-file-path': path, ...headers },
      body: body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : body,
      duplex: 'half' as const,
    };
    return uploadRoute(new Request('https://example.invalid/api/files', init));
  };
  const postFolder = (path: string, actor: Actor = 'a') =>
    uploadRoute(
      new Request('https://example.invalid/api/files', {
        method: 'POST',
        headers: { [ACTOR_HEADER]: actor, 'x-folder-path': path },
      }),
    );
  const listed = async (path: string) => {
    const response = await listRoute(
      new Request(`https://example.invalid/api/files?path=${encodeURIComponent(path)}`, {
        headers: { [ACTOR_HEADER]: 'a' },
      }),
    );
    return ((await response.json()) as { files: Array<{ path: string }> }).files;
  };
  const catalogA = () => world.catalogs.forWorkspace(world.a.workspaceId);
  const filesObjects = async () =>
    (
      await objects.listPage(`${workspaceFolder(world.a.workspaceId)}files`, { recursive: true })
    ).entries.map((entry) => entry.key);
  return {
    get world() {
      return world;
    },
    get objects() {
      return objects;
    },
    get legacy() {
      return legacy;
    },
    get install() {
      return install;
    },
    get post() {
      return post;
    },
    get postFolder() {
      return postFolder;
    },
    get listed() {
      return listed;
    },
    get catalogA() {
      return catalogA;
    },
    get filesObjects() {
      return filesObjects;
    },
  };
}
export type FileUploadFixture = ReturnType<typeof createFileUploadFixture>;
