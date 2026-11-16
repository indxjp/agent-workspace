import { listCatalogFiles } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { FileSearchResponseSchema } from '@indx-workspace/contracts/files';
import { afterEach, beforeEach, expect } from 'vitest';
import { GET as downloadRoute } from '../../app/api/files/[id]/route';
import { GET as searchRoute } from '../../app/api/files/search/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { encodeFileId } from './file-id';
import type { Member, World } from './file-search.worlds.test-support';
import { createRepositoryObjectStoreProvider, type FileTextStore } from './store';
const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const ctxOf = (member: Member): StorageContext => ({
  workspaceId: member.workspaceId,
  principalId: member.principalId,
  userId: member.userId,
});

export async function saveClaimedRow(
  world: World,
  objects: ObjectStore,
  {
    path,
    body,
    claimedSize,
  }: { readonly path: string; readonly body: Uint8Array; readonly claimedSize: number },
) {
  const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
  const objectId = crypto.randomUUID();
  const reserved = await catalog.reserve(path, {
    objectId,
    ownerPrincipalId: world.a.principalId,
    sizeBytes: claimedSize,
    contentType: 'text/plain',
  });
  await objects.write(storageObjectName(world.a.workspaceId, 'files', objectId), body, {});
  const confirmed = await catalog.confirm(reserved.row, {
    sizeBytes: claimedSize,
    contentType: 'text/plain',
  });
  if (confirmed === null) throw new Error('the row did not confirm');
  return confirmed.row;
}

afterEach(() => {
  clearApplicationContext();
});

const ACTOR_HEADER = 'x-test-actor';

function catalogTexts(
  world: World,
  workspaceId: string,
  cache: Map<string, string>,
): FileTextStore {
  const ready = async () =>
    (await listCatalogFiles(await world.catalogs.forWorkspace(workspaceId))).filter(
      (row) => row.kind === 'file',
    );
  return {
    listStale: async () =>
      (await ready())
        .filter((row) => !cache.has(row.id))
        .map((row) => ({
          id: row.id,
          path: row.path,
          storageKey: row.storageKey ?? row.path,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          updatedAt: '1',
        })),
    replace: (fileId, _source, passages) => {
      cache.set(fileId, passages.map((passage) => passage.terms).join(' '));
      return Promise.resolve(true);
    },
    search: async (tsquery, _limit, allowed) => {
      const wanted = [...tsquery.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
      return (await ready()).flatMap((row) =>
        (allowed === null || allowed.includes(row.id)) &&
        wanted.every((term) => (cache.get(row.id) ?? '').split(' ').includes(term))
          ? [{ fileId: row.id, path: row.path, page: null, text: 'found', score: 0.5 }]
          : [],
      );
    },
  };
}

export {
  initializeDatabase,
  memoryWorld,
  postgresWorld,
  type World,
} from './file-search.worlds.test-support';

export function createFileSearchFixture(setup: () => Promise<World>) {
  return new FileSearchFixture(setup);
}

class FileSearchFixture {
  constructor(private readonly setup: () => Promise<World>) {
    beforeEach(() => this.reset());
  }

  private worldValue: World | undefined;
  get world(): World {
    if (this.worldValue === undefined) throw new Error('fixture world not initialized');
    return this.worldValue;
  }

  private storageValue: StorageService | undefined;
  private get storage(): StorageService {
    if (this.storageValue === undefined) throw new Error('fixture storage not initialized');
    return this.storageValue;
  }

  private legacy = createInMemoryObjectStoreProvider();

  private caches = new Map<string, Map<string, string>>();

  private objectsValue: ObjectStore | undefined;
  get objects(): ObjectStore {
    if (this.objectsValue === undefined) throw new Error('fixture objects not initialized');
    return this.objectsValue;
  }

  private install(): void {
    this.objectsValue = createInMemoryObjectStore();
    this.storageValue = createStorageService({
      catalog: (workspaceId) => this.world.catalogs.forWorkspace(workspaceId),
      objects: this.objects,
      log: noLog,
    });
    const principals = new Map([
      ['a', this.world.a],
      ['b', this.world.b],
    ]);
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
          texts: {
            forWorkspace: (workspaceId) => {
              const cache = this.caches.get(workspaceId) ?? new Map<string, string>();
              this.caches.set(workspaceId, cache);
              return Promise.resolve(catalogTexts(this.world, workspaceId, cache));
            },
          },
          resolveWorkspace: () =>
            Promise.resolve({ kind: 'workspace', workspaceId: this.world.a.workspaceId }),
        },
      },
      rbac: {
        directory: createMemoryDirectory({
          users: [this.world.a, this.world.b].map((member) => ({
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
                  label: 'Search test key',
                }),
          );
        },
      },
    });
  }

  private async reset() {
    this.worldValue = await this.setup();
    this.caches.clear();
    this.install();
  }

  async save(path: string, text: string, area: 'files' | 'skills' = 'files') {
    const saved = await this.storage.save(ctxOf(this.world.a), {
      area,
      path,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(bytesOf(text)),
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    return saved.row;
  }

  async hitPaths(actor: 'a' | 'b', word: string): Promise<string[]> {
    const response = await searchRoute(
      new Request(`https://example.invalid/api/files/search?q=${word}`, {
        headers: { [ACTOR_HEADER]: actor },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return FileSearchResponseSchema.parse(await response.json()).hits.map((hit) => hit.path);
  }

  downloadStatus = async (actor: 'a' | 'b', path: string): Promise<number> =>
    (
      await downloadRoute(
        new Request(`https://example.invalid/api/files/${encodeFileId(path)}`, {
          headers: { [ACTOR_HEADER]: actor },
        }),
        { params: Promise.resolve({ id: encodeFileId(path) }) },
      )
    ).status;
}
