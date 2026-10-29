/**
 * `POST /api/files/:id/download-urls` signs the catalog row's object (the storage design, §05): a
 * new-naming row by its object id, a legacy row by its storage key, as a link on the storage domain
 * that forces an attachment and is never logged. Driven with real `Request` objects over the
 * catalog service, on the in-memory catalog and on PostgreSQL.
 */
// @story US-STO-05
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  SignedUrlUnsupportedError,
  storageObjectName,
  type ObjectStore,
  type SignedUrlRequest,
} from '@agent-workspace/core/storage';
import {
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  PRESIGNED_URL_MAX_TTL_SECONDS,
  PRESIGNED_URL_MIN_TTL_SECONDS,
  PresignedUrlSchema,
} from '@indx-workspace/contracts/files';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/roles';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { captureLog } from '../telemetry/capture-log';
import { encodeFileId } from './file-id';
import { createRepositoryObjectStoreProvider } from './store';

const ACTOR_HEADER = 'x-test-actor';
const APP_ORIGIN = 'https://app.invalid';
const STORAGE_ORIGIN = 'https://storage.invalid';
const LEGACY_ORIGIN = 'https://legacy-storage.invalid';

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

type Actor = 'a' | 'b' | 'viewer';

interface World {
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

function memoryWorld(): Promise<World> {
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

async function postgresWorld(): Promise<World> {
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

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']?.trim();
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

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`download links on the ${name}`, () => {
    let world: World;
    let storage: StorageService;
    let signed: Signed[];
    let failSigning: boolean;
    let signature: string;
    const legacy = createInMemoryObjectStoreProvider();

    /** A signer that spells out the key and request it was asked for, with a runtime-built signature. */
    function signing<T extends ObjectStore>(store: T, origin: string): T {
      return {
        ...store,
        createSignedUrl: (key: string, request: SignedUrlRequest) => {
          signed.push({ origin, key, request });
          if (failSigning) {
            return Promise.reject(new Error(`${origin}/${key}?X-Test-Signature=${signature}`));
          }
          return Promise.resolve({
            url: `${origin}/${key}?X-Test-Signature=${signature}`,
            headers: {},
          });
        },
      };
    }

    /** Install the files runtime over the catalog service. */
    function install(): void {
      storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects: signing(createInMemoryObjectStore(), STORAGE_ORIGIN),
        legacy: {
          files: {
            forWorkspace: (workspaceId) => signing(legacy.forWorkspace(workspaceId), LEGACY_ORIGIN),
          },
        },
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
      world = await setup();
      signed = [];
      failSigning = false;
      signature = crypto.randomUUID().replaceAll('-', '');
      install();
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

    /** A ready row in the old naming: `objectId` null, the bytes at the path in the area store. */
    async function saveLegacy(path: string, text: string) {
      await legacy.forWorkspace(world.a.workspaceId).write(path, bytesOf(text), {});
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

    const mint = (actor: Actor, path: string, body: unknown = {}) =>
      downloadUrlRoute(
        new Request(`${APP_ORIGIN}/api/files/${encodeFileId(path)}/download-urls`, {
          method: 'POST',
          headers: { [ACTOR_HEADER]: actor, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: encodeFileId(path) }) },
      );

    async function minted(path: string, body?: unknown, actor: Actor = 'a') {
      const response = await mint(actor, path, body);
      expect(response.status, await response.clone().text()).toBe(201);
      return PresignedUrlSchema.parse(await response.json());
    }

    // @story US-STO-05
    it('[US-STO-05][api][sdk] signed download comes from the storage domain', async () => {
      const row = await save('reports/q3.txt', 'quarter three');
      expect(row.objectId).not.toBeNull();

      const link = await minted('reports/q3.txt');

      expect(new URL(link.url).origin).toBe(STORAGE_ORIGIN);
      expect(new URL(link.url).origin).not.toBe(APP_ORIGIN);
      expect(link.method).toBe('GET');
      expect(signed).toHaveLength(1);
      const [call] = signed;
      expect(call?.key).toBe(storageObjectName(world.a.workspaceId, 'files', row.objectId ?? ''));
      expect(call?.request.method).toBe('GET');
      expect(call?.request.responseDisposition).toMatch(/^attachment;/u);
      expect(call?.request.responseDisposition).toContain('q3.txt');
      expect(call?.request.responseContentType).toBe('text/plain');
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a legacy row signs its legacy key on the legacy area store', async () => {
      const row = await saveLegacy('old/report.txt', 'old bytes');
      expect(row.objectId ?? null).toBeNull();

      const link = await minted('old/report.txt');

      expect(new URL(link.url).origin).toBe(LEGACY_ORIGIN);
      expect(signed).toHaveLength(1);
      expect(signed[0]?.key).toBe(row.storageKey);
      expect(signed[0]?.request.responseDisposition).toMatch(/^attachment;/u);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] an omitted ttl is the default and an explicit one is passed through', async () => {
      await save('ttl.txt', 'x');

      const before = Date.now();
      const defaulted = await minted('ttl.txt');
      expect(signed[0]?.request.expiresInSeconds).toBe(PRESIGNED_URL_DEFAULT_TTL_SECONDS);
      const lifetime = Date.parse(defaulted.expiresAt) - before;
      expect(lifetime).toBeGreaterThanOrEqual(PRESIGNED_URL_DEFAULT_TTL_SECONDS * 1000);
      expect(lifetime).toBeLessThan(PRESIGNED_URL_DEFAULT_TTL_SECONDS * 1000 + 5000);

      await minted('ttl.txt', { ttlSeconds: PRESIGNED_URL_MIN_TTL_SECONDS });
      await minted('ttl.txt', { ttlSeconds: PRESIGNED_URL_MAX_TTL_SECONDS });
      expect(signed.map((call) => call.request.expiresInSeconds)).toEqual([
        PRESIGNED_URL_DEFAULT_TTL_SECONDS,
        PRESIGNED_URL_MIN_TTL_SECONDS,
        PRESIGNED_URL_MAX_TTL_SECONDS,
      ]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a ttl above the maximum is a 400 and nothing is signed', async () => {
      await save('ttl.txt', 'x');
      for (const ttlSeconds of [
        PRESIGNED_URL_MAX_TTL_SECONDS + 1,
        PRESIGNED_URL_MIN_TTL_SECONDS - 1,
      ]) {
        const response = await mint('a', 'ttl.txt', { ttlSeconds });
        expect(response.status).toBe(400);
      }
      expect(signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] the service refuses a ttl outside the contract before it signs', async () => {
      const row = await save('ttl.txt', 'x');
      const headers = { responseContentType: 'text/plain', responseDisposition: 'attachment' };
      for (const ttlSeconds of [
        PRESIGNED_URL_MAX_TTL_SECONDS + 1,
        PRESIGNED_URL_MIN_TTL_SECONDS - 1,
      ]) {
        await expect(
          storage.signDownload(ctxOf(world.a), row, { ttlSeconds, ...headers }),
        ).rejects.toBeInstanceOf(SignedUrlUnsupportedError);
      }
      expect(signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a pending, deleting or absent row answers 404 and signs nothing', async () => {
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      await catalog.reserve('pending.txt', {
        area: 'files',
        objectId: crypto.randomUUID(),
        ownerPrincipalId: world.a.principalId,
        sizeBytes: 0,
        contentType: 'text/plain',
      });
      await save('removed.txt', 'x');
      await catalog.remove('removed.txt');

      for (const path of ['pending.txt', 'removed.txt', 'absent.txt']) {
        expect((await mint('a', path)).status, path).toBe(404);
      }
      expect(signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] another workspace and the attachments folder answer 404, never 403', async () => {
      await save('private/plan.txt', 'x');
      await save('.attachments/s1/photo.png', 'x');

      expect((await mint('b', 'private/plan.txt')).status).toBe(404);
      expect((await mint('a', '.attachments/s1/photo.png')).status).toBe(404);
      expect(signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a member of the same workspace without read access is refused 403', async () => {
      await save('private/plan.txt', 'x');

      // RBAC answers 403 here, as it does for `GET /api/files/:id`: the viewer is a member of the
      // workspace, so there is no tenant to conceal (`presign.routes.test.ts` asserts the same).
      const response = await mint('viewer', 'private/plan.txt');
      expect(response.status).toBe(403);
      expect(signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a download link is never logged, whether signing succeeds or fails', async () => {
      await save('secret.txt', 'x');
      const log = captureLog();
      const output = vi.spyOn(console, 'log');
      const errors = vi.spyOn(console, 'error');
      try {
        const link = await minted('secret.txt');
        expect(link.url).toContain(signature);

        failSigning = true;
        const failed = await mint('a', 'secret.txt');
        expect(failed.status).toBe(502);
        const failedBody = await failed.text();

        for (const written of [
          log.text(),
          failedBody,
          JSON.stringify(output.mock.calls),
          JSON.stringify(errors.mock.calls),
        ]) {
          expect(written).not.toContain(signature);
          expect(written).not.toContain(STORAGE_ORIGIN);
        }
      } finally {
        log.restore();
      }
    });
  });
}

defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
