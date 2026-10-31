/**
 * `POST /api/sessions/:id/attachments` (issue #1308, ADR-0146 D5-D6) saves through the catalog
 * service (the storage design, §04 "Saving a file", "Size limits"). Driven through the real route
 * with real `Request` objects on the in-memory catalog and on PostgreSQL.
 */
import { createHash } from 'node:crypto';
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
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { listAll } from '@agent-workspace/core/storage/streams';
import {
  SURFACE_ATTACHMENT_MAX_BYTES,
  SURFACE_ATTACHMENTS_MAX_FILES,
  SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES,
  SurfaceAttachmentResponseSchema,
  type SurfaceDefinition,
} from '@indx-workspace/contracts/surfaces';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE as deleteRoute, GET as downloadRoute } from '../../../app/api/files/[id]/route';
import { GET as listRoute } from '../../../app/api/files/route';
import { POST } from '../../../app/api/sessions/[engineSessionId]/attachments/route';
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { createAgentRunResourceLoader } from '../../compose/resource-loader';
import { encodeFileId } from '../../files/file-id';
import { createRepositoryObjectStoreProvider } from '../../files/store';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import { Principal } from '../../rbac/principal';
import { createInMemoryCatalogStore } from '../../resources/catalog-store.memory';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../../resources/catalog-store';
import { resolveRunAttachments } from '../../runs/attachments';
import { createStorageService, type StorageService } from '../../storage/service';
import { purgeSessionAttachments } from './attachments';
import { resetSurfaceLimits, SURFACE_RATE_LIMITS } from './limits';
import { listCatalogFiles } from '@agent-workspace/core/db';

const SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const ACTOR_HEADER = 'x-test-actor';
const OFFERS: SurfaceDefinition = { name: 'main', agent: 'support', parts: { attachments: true } };
const WITHOUT: SurfaceDefinition = { name: 'main', agent: 'support' };

type Actor = 'visitor' | 'member' | 'admin' | 'run';

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly workspaceId: string;
  readonly principalId: string;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const streamOf = (size: number): ReadableStream<Uint8Array> =>
  new Blob([new Uint8Array(size)]).stream();
/** A one-byte body that records whether anything pulled on it; `highWaterMark: 0` pulls nothing up front. */
function trackedBody(): {
  readonly body: ReadableStream<Uint8Array>;
  readonly read: () => boolean;
} {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, read: () => pulled };
}

function memoryWorld(): Promise<World> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'acme' }]),
    workspaceId,
    principalId: crypto.randomUUID(),
  });
}

let isolated: IsolatedTestDatabase | undefined;

async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const { db } = isolated;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'attachments' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes,
    }),
    scopes,
    workspaceId,
    principalId,
  };
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  }
  isolated = await createIsolatedTestDatabase('aw_surface_attachments');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(() => {
  clearApplicationContext();
  resetSurfaceLimits();
});

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`attachments on the ${name}`, () => {
    let world: World;
    let root: ObjectStore;
    let storage: StorageService;
    let surface: SurfaceDefinition | null;
    /** The archive state of the project the session lives in; `null` is a session in no project. */
    let projectArchivedAt: Date | null | undefined;
    /** Who owns the session row; a member reaches it only as that owner (or as an admin). */
    let sessionOwner: string | undefined;
    let visitor: Principal;
    const legacy = createInMemoryObjectStoreProvider();
    const runtimeStore = () =>
      createRepositoryObjectStoreProvider({ store: legacy, scopes: world.scopes });

    /** Install the files runtime; without `withStorage` it has no catalog service. */
    function install(withStorage = true): void {
      root = createInMemoryObjectStore();
      storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects: root,
        log: noLog,
      });
      const base = Principal.fromApiKey({
        principalId: world.principalId,
        apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        workspaceId: world.workspaceId,
        role: 'builder',
        label: 'Attachment route test key',
      });
      visitor = Principal.fromBrowserToken(base, { kind: 'session', id: SESSION });
      const principals: Record<Actor, Principal> = {
        visitor,
        run: Principal.fromBrowserToken(base, { kind: 'run', id: SESSION }),
        member: base,
        admin: Principal.fromApiKey({
          principalId: world.principalId,
          apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workspaceId: world.workspaceId,
          role: 'admin',
          label: 'Attachment route admin key',
        }),
      };
      const PROJECT = '55555555-5555-4555-8555-555555555555';
      installTestDomains({
        projects: {
          resolveActor: () => Promise.reject(new Error('unused')),
          forWorkspace: () =>
            Promise.resolve({
              sessions: {
                get: () =>
                  Promise.resolve({
                    projectId: projectArchivedAt === undefined ? null : PROJECT,
                    ownerPrincipalId: sessionOwner,
                  }),
              },
              projects: {
                get: () =>
                  Promise.resolve(
                    projectArchivedAt === undefined ? null : { archivedAt: projectArchivedAt },
                  ),
              },
            } as never),
        },
        files: {
          kind: 'serving',
          runtime: {
            store: runtimeStore(),
            catalog: world.catalogs,
            ...(withStorage ? { storage } : {}),
            resolveWorkspace: () =>
              Promise.resolve({ kind: 'workspace', workspaceId: world.workspaceId }),
          },
        },
        rbac: {
          directory: createMemoryDirectory({
            users: [
              {
                email: 'owner@example.test',
                name: 'Owner',
                workspaceId: world.workspaceId,
                role: 'owner',
              },
            ],
          }),
          identify(request: Request) {
            const actor = request.headers.get(ACTOR_HEADER);
            return Promise.resolve(actor === null ? null : principals[actor as Actor]);
          },
        },
        surfaces: {
          kind: 'serving',
          runtime: {
            resolve: () => Promise.reject(new Error('unused')),
            open: () => Promise.reject(new Error('unused')),
            checkModel: () => Promise.reject(new Error('unused')),
            visitorSurface: (workspaceId, sessionId) =>
              Promise.resolve(
                workspaceId === world.workspaceId && sessionId === SESSION && surface !== null
                  ? { surface }
                  : null,
              ),
            servedSurfaces: () => Promise.reject(new Error('unused')),
          },
        },
      });
    }

    beforeEach(async () => {
      world = await setup();
      surface = OFFERS;
      projectArchivedAt = undefined;
      sessionOwner = undefined;
      install();
    });

    function upload(
      fileName: string | null,
      body: BodyInit = 'hello',
      options: { actor?: Actor | null; session?: string; headers?: Record<string, string> } = {},
    ): Promise<Response> {
      const actor = options.actor === undefined ? 'visitor' : options.actor;
      const query = fileName === null ? '' : `?name=${encodeURIComponent(fileName)}`;
      // A variable, not a literal: the DOM `RequestInit` has no `duplex`.
      const init = {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          ...(actor === null ? {} : { [ACTOR_HEADER]: actor }),
          ...options.headers,
        },
        body,
        duplex: 'half' as const,
      };
      const engineSessionId = options.session ?? SESSION;
      return POST(
        new Request(
          `https://example.invalid/api/sessions/${engineSessionId}/attachments${query}`,
          init,
        ),
        { params: Promise.resolve({ engineSessionId }) },
      );
    }

    async function code(response: Response): Promise<string> {
      const body = (await response.json()) as { error?: { code?: string } };
      return body.error?.code ?? '';
    }

    const catalog = () => world.catalogs.forWorkspace(world.workspaceId);
    const ctx = () => ({
      workspaceId: world.workspaceId,
      principalId: world.principalId,
      userId: null,
    });
    /** A seeded attachment written the way the route writes one, without the per-session rate limit. */
    async function seed(session: string, size: number): Promise<void> {
      const saved = await storage.save(ctx(), {
        area: 'files',
        path: `.attachments/${session}/${crypto.randomUUID()}/f.bin`,
        body: streamOf(size),
        maxBytes: size,
        replace: false,
      });
      expect(saved.ok).toBe(true);
    }
    const rootObjects = async () =>
      (
        await root.listPage(`workspaces/${world.workspaceId}/files`, { recursive: true })
      ).entries.map((entry) => entry.key);
    const legacyObjects = async () =>
      (
        await listAll(legacy.forWorkspace(world.workspaceId), '.attachments', { recursive: true })
      ).map((entry) => entry.key);
    const readyFiles = async () =>
      (await listCatalogFiles(await catalog())).filter((row) => row.kind === 'file');
    /** What a refusal must leave unchanged: the ready rows, nothing pending or half-removed, the objects. */
    async function stored() {
      const rows = await catalog();
      return {
        files: (await readyFiles()).map((row) => row.path),
        pending: await rows.countPending(),
        deleting: (await rows.deleting()).length,
        objects: await rootObjects(),
        legacyObjects: await legacyObjects(),
      };
    }

    // @story US-STO-11
    it('[US-STO-11][api][chat] an attachment is saved through the service', async () => {
      const response = await upload('scan.txt');
      expect(response.status, await response.clone().text()).toBe(201);
      const body = SurfaceAttachmentResponseSchema.parse(await response.json());
      expect(body.size).toBe(5);
      expect(body.path).toMatch(new RegExp(`^\\.attachments/${SESSION}/[0-9a-f-]{36}/scan\\.txt$`));
      const row = await (await catalog()).get(body.path);
      expect(row).toMatchObject({ id: body.fileId, status: 'ready', sizeBytes: 5 });
      const objectId = row?.objectId ?? null;
      if (objectId === null) throw new Error('the row has no object id');
      expect(await rootObjects()).toEqual([
        storageObjectName(world.workspaceId, 'files', objectId),
      ]);
      expect(await legacyObjects()).toEqual([]);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] an archived project refuses attachments', async () => {
      const before = await stored();
      projectArchivedAt = new Date();
      const refused = await upload('scan.txt');
      expect(refused.status).toBe(404);
      expect(await code(refused)).toBe('file_not_found');
      expect(await stored()).toEqual(before);

      projectArchivedAt = null;
      const restored = await upload('scan.txt');
      expect(restored.status, await restored.clone().text()).toBe(201);
      expect((await stored()).files).toHaveLength(1);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] a console member attaches to their own session, not to another’s', async () => {
      // A console session is no surface visitor's: it has no surface, so only the member path admits it.
      surface = null;
      const unowned = await upload('scan.txt', 'hello', { actor: 'member' });
      expect(unowned.status, 'a session the member does not own').toBe(404);

      sessionOwner = world.principalId;
      const saved = await upload('scan.txt', 'hello', { actor: 'member' });
      expect(saved.status, await saved.clone().text()).toBe(201);
      expect((await readyFiles()).map((row) => row.path)).toEqual([
        expect.stringMatching(new RegExp(`^\\.attachments/${SESSION}/[0-9a-f-]{36}/scan\\.txt$`)),
      ]);

      sessionOwner = crypto.randomUUID();
      const other = await upload('b.txt', 'hello', { actor: 'member' });
      expect(other.status).toBe(404);
      expect(await code(other)).toBe('file_not_found');
      expect(await readyFiles()).toHaveLength(1);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] a console admin attaches to another member’s session', async () => {
      // Pins `mayWriteToSession`'s admin clause (`canAccessSession`'s rule). The RBAC matrix gives
      // Admin `sessions: OWN_ONLY`; if the route is moved onto it, this becomes a concealed 404.
      surface = null;
      sessionOwner = crypto.randomUUID();
      const saved = await upload('scan.txt', 'hello', { actor: 'admin' });
      expect(saved.status, await saved.clone().text()).toBe(201);
      expect(await readyFiles()).toHaveLength(1);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] an archived project refuses a console member’s attachment', async () => {
      surface = null;
      sessionOwner = world.principalId;
      const before = await stored();
      projectArchivedAt = new Date();
      const refused = await upload('scan.txt', 'hello', { actor: 'member' });
      expect(refused.status).toBe(404);
      expect(await code(refused)).toBe('file_not_found');
      expect(await stored()).toEqual(before);

      projectArchivedAt = null;
      const restored = await upload('scan.txt', 'hello', { actor: 'member' });
      expect(restored.status, await restored.clone().text()).toBe(201);
    });

    // @story US-STO-11
    it('[US-STO-11][api][run] an attached file reaches the run read-only', async () => {
      const bytes = new TextEncoder().encode('hello');
      const body = SurfaceAttachmentResponseSchema.parse(await (await upload('scan.txt')).json());
      const row = await (await catalog()).get(body.path);
      expect(row).toMatchObject({ status: 'ready', objectId: expect.any(String) as unknown });
      const verdict = await resolveRunAttachments(
        { ...visitor, role: 'builder', userId: null } as never,
        [{ fileId: body.fileId }],
      );
      expect(verdict).toEqual({
        kind: 'ok',
        files: [{ fileId: body.fileId, path: body.path, kind: 'file' }],
      });

      const loader = createAgentRunResourceLoader({
        catalog: world.catalogs,
        storage,
      });
      const loaded = await loader.load(world.workspaceId, {
        files: [{ fileId: body.fileId, access: 'read' }],
        skillIds: [],
        connectorIds: [],
      });
      expect(loaded.files).toEqual([
        {
          kind: 'file',
          path: body.path,
          access: 'read',
          size: Buffer.byteLength(bytes),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ]);
    });

    /** The console member's run principal: no token scope, the session's owner. */
    const consoleRunner = (workspaceId = world.workspaceId) => ({
      principalId: world.principalId,
      ownerPrincipalId: world.principalId,
      userId: null,
      workspaceId,
      role: 'builder' as const,
      scope: null,
    });

    // @story US-STO-11
    it('[US-STO-11][api][run] a console-attached file reaches the run on its session', async () => {
      surface = null;
      sessionOwner = world.principalId;
      const saved = await upload('scan.txt', 'hello', { actor: 'member' });
      expect(saved.status, await saved.clone().text()).toBe(201);
      const body = SurfaceAttachmentResponseSchema.parse(await saved.json());
      expect(
        await resolveRunAttachments(consoleRunner(), [{ fileId: body.fileId }], SESSION),
      ).toEqual({ kind: 'ok', files: [{ fileId: body.fileId, path: body.path, kind: 'file' }] });
    });

    // @story US-STO-11
    it('[US-STO-11][api][run] a console run is refused another session’s or workspace’s attachment', async () => {
      surface = null;
      sessionOwner = world.principalId;
      const body = SurfaceAttachmentResponseSchema.parse(
        await (await upload('scan.txt', 'hello', { actor: 'member' })).json(),
      );
      const requested = [{ fileId: body.fileId }];
      const statusOf = async (
        verdict: Awaited<ReturnType<typeof resolveRunAttachments>>,
      ): Promise<string> => (verdict.kind === 'ok' ? 'ok' : code(verdict.response));
      expect(await statusOf(await resolveRunAttachments(consoleRunner(), requested, SESSION))).toBe(
        'ok',
      );
      expect(
        await statusOf(await resolveRunAttachments(consoleRunner(), requested, OTHER_SESSION)),
        'a run on another session',
      ).toBe('file_not_found');
      expect(
        await statusOf(await resolveRunAttachments(consoleRunner(), requested, null)),
        'a run that opens a new session',
      ).toBe('file_not_found');
      const elsewhere = (await setup()).workspaceId;
      expect(
        await statusOf(await resolveRunAttachments(consoleRunner(elsewhere), requested, SESSION)),
        'another workspace',
      ).toBe('file_not_found');
      sessionOwner = crypto.randomUUID();
      expect(
        await statusOf(await resolveRunAttachments(consoleRunner(), requested, SESSION)),
        'a session the caller does not own',
      ).toBe('file_not_found');
    });

    it('gives two uploads of the same name two different paths', async () => {
      const first = SurfaceAttachmentResponseSchema.parse(await (await upload('a.txt')).json());
      const second = SurfaceAttachmentResponseSchema.parse(await (await upload('a.txt')).json());
      expect(first.path).not.toBe(second.path);
      expect(first.fileId).not.toBe(second.fileId);
    });

    it('answers a concealed 404 for a surface without the part, a member, a run token and no credential', async () => {
      surface = WITHOUT;
      const withoutPart = await upload('a.txt');
      expect(withoutPart.status).toBe(404);
      expect(await code(withoutPart)).toBe('file_not_found');
      surface = OFFERS;
      for (const actor of ['member', 'run'] as const) {
        const refused = await upload('a.txt', 'hello', { actor });
        expect(refused.status, actor).not.toBe(201);
      }
      expect((await upload('a.txt', 'hello', { actor: 'member' })).status).toBe(404);
      expect((await upload('a.txt', 'hello', { actor: null })).status).toBe(401);
      expect(await readyFiles()).toEqual([]);
      expect(await rootObjects()).toEqual([]);
    });

    it('refuses another session’s id, writing nothing', async () => {
      const response = await upload('a.txt', 'hello', { session: OTHER_SESSION });
      expect(response.status).toBe(403);
      expect(await readyFiles()).toEqual([]);
      expect(await rootObjects()).toEqual([]);
    });

    it.each(['../x', '.env', 'a/b', 'a\\b', 'a\u0000b', '', 'é'.repeat(128)])(
      'refuses the name %j with 400 invalid_attachment_name',
      async (fileName) => {
        const response = await upload(fileName);
        expect(response.status).toBe(400);
        expect(await code(response)).toBe('invalid_attachment_name');
        expect(await rootObjects()).toEqual([]);
      },
    );

    it('refuses a missing name', async () => {
      expect((await upload(null)).status).toBe(400);
    });

    it('accepts a name of exactly 255 bytes', async () => {
      expect((await upload('a'.repeat(255))).status).toBe(201);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] a file over SURFACE_ATTACHMENT_MAX_BYTES is refused and leaves no row and no object', async () => {
      const before = await stored();
      const unread = trackedBody();
      const declared = await upload('big.bin', unread.body, {
        headers: { 'content-length': String(SURFACE_ATTACHMENT_MAX_BYTES + 1) },
      });
      expect(declared.status).toBe(413);
      expect(await code(declared)).toBe('request_body_too_large');
      expect(unread.read()).toBe(false);
      const streamed = await upload('big.bin', streamOf(SURFACE_ATTACHMENT_MAX_BYTES + 1));
      expect(streamed.status).toBe(413);
      expect(await code(streamed)).toBe('request_body_too_large');
      expect(await stored()).toEqual(before);

      const exact = await upload('exact.bin', streamOf(SURFACE_ATTACHMENT_MAX_BYTES));
      expect(exact.status).toBe(201);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] the file after SURFACE_ATTACHMENTS_MAX_FILES is refused and leaves no row and no object', async () => {
      for (let count = 0; count < SURFACE_ATTACHMENTS_MAX_FILES; count += 1) {
        await seed(SESSION, 1);
      }
      const before = await stored();
      const response = await upload('one-more.txt');
      expect(response.status).toBe(413);
      expect(await code(response)).toBe('attachments_quota_exceeded');
      expect(await stored()).toEqual(before);
      expect(before.files).toHaveLength(SURFACE_ATTACHMENTS_MAX_FILES);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] a file past SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES is refused, counting only its own session', async () => {
      await seed(OTHER_SESSION, SURFACE_ATTACHMENT_MAX_BYTES);
      const half = SURFACE_ATTACHMENT_MAX_BYTES / 2;
      for (let left = SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES - half; left > 0;) {
        const size = Math.min(SURFACE_ATTACHMENT_MAX_BYTES, left);
        await seed(SESSION, size);
        left -= size;
      }
      const before = await stored();
      const response = await upload('over.bin', streamOf(half + 1));
      expect(response.status).toBe(413);
      expect(await code(response)).toBe('attachments_quota_exceeded');
      expect(await stored()).toEqual(before);

      expect((await upload('fits.bin', streamOf(half))).status).toBe(201);
    }, 120_000);

    it('answers 429 surface_rate_limited with Retry-After on the eleventh upload in a minute', async () => {
      for (let sent = 0; sent < SURFACE_RATE_LIMITS.attachmentsPerSession; sent += 1) {
        expect((await upload(`f${String(sent)}.txt`)).status).toBe(201);
      }
      const response = await upload('late.txt');
      expect(response.status).toBe(429);
      expect(await code(response)).toBe('surface_rate_limited');
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] purge removes the rows and their objects, and a second purge is a no-op', async () => {
      expect((await upload('a.txt')).status).toBe(201);
      expect((await upload('b.txt')).status).toBe(201);
      await seed(OTHER_SESSION, 1);
      const kept = await storage.save(ctx(), {
        area: 'files',
        path: 'docs/promoted.txt',
        body: streamOf(1),
        maxBytes: 1,
        replace: false,
      });
      expect(kept.ok).toBe(true);

      await expect(purgeSessionAttachments(world.workspaceId, [SESSION])).resolves.toBe(2);
      await expect(purgeSessionAttachments(world.workspaceId, [SESSION])).resolves.toBe(0);
      expect((await readyFiles()).map((row) => row.path).sort()).toEqual([
        expect.stringMatching(new RegExp(`^\\.attachments/${OTHER_SESSION}/`)),
        'docs/promoted.txt',
      ]);
      expect(await legacyObjects()).toEqual([]);
      expect(await rootObjects()).toHaveLength(2);
      expect((await upload('after.txt')).status).toBe(201);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] a files runtime without the catalog service answers 503 and stores nothing', async () => {
      install(false);
      const before = await stored();
      const response = await upload('plain.txt');
      expect(response.status).toBe(503);
      expect(await code(response)).toBe('files_runtime_not_configured');
      expect(await stored()).toEqual(before);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] purge returns 0 and removes nothing when the files runtime has no catalog service', async () => {
      expect((await upload('a.txt')).status).toBe(201);
      install(false);
      await expect(purgeSessionAttachments(world.workspaceId, [SESSION])).resolves.toBe(0);
      expect(await readyFiles()).toHaveLength(1);
    });

    // @story US-STO-11
    it('[US-STO-11][api][chat] a failed catalogue write removes the object and leaks no cause text', async () => {
      const rows = await catalog();
      vi.spyOn(rows, 'confirm').mockRejectedValueOnce(new Error('SELECT secret FROM sql'));
      vi.spyOn(world.catalogs, 'forWorkspace').mockResolvedValue(rows);
      const response = await upload('a.txt');
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain('internal_error');
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain('secret');
      expect(await rootObjects()).toEqual([]);
      expect(await readyFiles()).toEqual([]);
    });

    it('a saved attachment stays out of GET /api/files, and the files routes refuse its path', async () => {
      const saved = SurfaceAttachmentResponseSchema.parse(await (await upload('scan.txt')).json());
      const asMember = (method: string, path: string) =>
        new Request(`https://example.invalid${path}`, {
          method,
          headers: { [ACTOR_HEADER]: 'member' },
        });

      const root = await listRoute(asMember('GET', '/api/files'));
      expect(root.status).toBe(200);
      expect(JSON.stringify(await root.json())).not.toContain('.attachments');
      expect((await listRoute(asMember('GET', '/api/files?path=.attachments'))).status).toBe(404);

      const id = encodeFileId(saved.path);
      const download = await downloadRoute(asMember('GET', `/api/files/${id}`), {
        params: Promise.resolve({ id }),
      });
      expect(download.status).toBe(404);
      expect(await code(download)).toBe('file_not_found');
      const removed = await deleteRoute(asMember('DELETE', `/api/files/${id}`), {
        params: Promise.resolve({ id }),
      });
      expect(removed.status).toBe(400);
      expect(await code(removed)).toBe('reserved_path');
      expect(await (await catalog()).get(saved.path)).toMatchObject({ status: 'ready' });
    });
  });
}

defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
