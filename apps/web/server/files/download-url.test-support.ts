/**
 * Shared harness for the download-link route suites: the in-memory and PostgreSQL worlds, a signer
 * that records what it was asked for, and the files runtime installed over the catalog service.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';

import { POST as downloadUrlRoute } from '../../app/api/files/[id]/download-urls/route';
import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
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
  type ObjectStore,
  type SignedUrlRequest,
} from '@agent-workspace/core/storage';
import { PresignedUrlSchema, type PresignedUrl } from '@indx-workspace/contracts/files';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/core/roles';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../storage/store';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { encodeFileId } from './file-id';
import { createRepositoryObjectStoreProvider } from './store';

export const APP_ORIGIN = 'https://app.invalid';
export const STORAGE_ORIGIN = 'https://storage.invalid';
const ACTOR_HEADER = 'x-test-actor';
const LEGACY_ORIGIN = 'https://legacy-storage.invalid';

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

type Actor = 'a' | 'b' | 'viewer';

export interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  readonly b: Member;
}

interface Signed {
  readonly origin: string;
  readonly key: string;
  readonly request: SignedUrlRequest;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

export function memoryWorld(): Promise<World> {
  const a = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  const b = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([
      { id: a.workspaceId, slug: 'acme' },
      { id: b.workspaceId, slug: 'globex' },
    ]),
    a,
    b,
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

export async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(isolated.db),
      scopes,
    }),
    scopes,
    a: await postgresMember(isolated.db),
    b: await postgresMember(isolated.db),
  };
}

/** Start the isolated PostgreSQL database for the suite and reset the runtime after each test. */
export function useDownloadUrlDatabase(readUrl: () => string | undefined): void {
  beforeAll(async () => {
    const url = readUrl()?.trim();
    if (!url) {
      throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
    }
    isolated = await createIsolatedTestDatabase('aw_files_download_url');
  }, 180_000);

  afterAll(async () => isolated?.close());

  afterEach(() => {
    clearApplicationContext();
    vi.restoreAllMocks();
  });
}

export const ctxOf = (member: Member): StorageContext => ({
  workspaceId: member.workspaceId,
  principalId: member.principalId,
  userId: member.userId,
});

type SavedRow = Extract<Awaited<ReturnType<StorageService['save']>>, { ok: true }>['row'];

/** The per-test state of one suite: reassigned before each test, read by the test bodies. */
interface DownloadHarness {
  world: World;
  storage: StorageService;
  signed: Signed[];
  failSigning: boolean;
  signature: string;
  save(path: string, text: string): Promise<SavedRow>;
  mint(actor: Actor, path: string, body?: unknown): Promise<Response>;
  minted(path: string, body?: unknown, actor?: Actor): Promise<PresignedUrl>;
}

/** Register the per-test setup for one world and return the harness the tests drive. */
export function useDownloadHarness(setup: () => Promise<World>): DownloadHarness {
  const legacy = createInMemoryObjectStoreProvider();
  const h = {} as DownloadHarness;

  /** A signer that spells out the key and request it was asked for, with a runtime-built signature. */
  function signing<T extends ObjectStore>(store: T, origin: string): T {
    return {
      ...store,
      createSignedUrl: (key: string, request: SignedUrlRequest) => {
        h.signed.push({ origin, key, request });
        const url = `${origin}/${key}?X-Test-Signature=${h.signature}`;
        if (h.failSigning) return Promise.reject(new Error(url));
        return Promise.resolve({ url, headers: {} });
      },
    };
  }

  /** Install the files runtime over the catalog service. */
  function install(): void {
    const { world } = h;
    h.storage = createStorageService({
      catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
      objects: signing(createInMemoryObjectStore(), STORAGE_ORIGIN),
      log: noLog,
    });
    // `viewer` is a member of `a`'s workspace whose role holds no `files` grant.
    const principals = new Map<string, { readonly member: Member; readonly role: Role }>([
      ['a', { member: world.a, role: 'owner' }],
      ['b', { member: world.b, role: 'owner' }],
      ['viewer', { member: { ...world.a, principalId: crypto.randomUUID() }, role: 'viewer' }],
    ]);
    installTestDomains({
      files: {
        kind: 'serving',
        runtime: {
          store: createRepositoryObjectStoreProvider({
            store: {
              forWorkspace: (workspaceId) =>
                signing(legacy.forWorkspace(workspaceId), LEGACY_ORIGIN),
            },
            scopes: world.scopes,
          }),
          catalog: world.catalogs,
          storage: h.storage,
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
          const found = principals.get(request.headers.get(ACTOR_HEADER) ?? 'a');
          return Promise.resolve(
            found === undefined
              ? null
              : Principal.fromApiKey({
                  principalId: found.member.principalId,
                  apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  workspaceId: found.member.workspaceId,
                  role: found.role,
                  label: 'Download link test key',
                }),
          );
        },
      },
    });
  }

  beforeEach(async () => {
    h.world = await setup();
    h.signed = [];
    h.failSigning = false;
    h.signature = crypto.randomUUID().replaceAll('-', '');
    install();
  });

  h.save = async (path, text) => {
    const saved = await h.storage.save(ctxOf(h.world.a), {
      area: 'files',
      path,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(bytesOf(text)),
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    return saved.row;
  };

  h.mint = (actor, path, body = {}) =>
    downloadUrlRoute(
      new Request(`${APP_ORIGIN}/api/files/${encodeFileId(path)}/download-urls`, {
        method: 'POST',
        headers: { [ACTOR_HEADER]: actor, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: encodeFileId(path) }) },
    );

  h.minted = async (path, body, actor = 'a') => {
    const response = await h.mint(actor, path, body);
    expect(response.status, await response.clone().text()).toBe(201);
    return PresignedUrlSchema.parse(await response.json());
  };

  return h;
}
