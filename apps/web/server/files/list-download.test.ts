/**
 * `GET /api/files` and `GET /api/files/:id` read the catalog (the storage design, §04 "File states"):
 * only ready rows are listed, and a download streams the row's object as an attachment. Driven with
 * real `Request` objects over the catalog service, on the in-memory catalog and on PostgreSQL.
 */
// @story US-STO-01
// @story US-STO-05
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';
import {
  DELETE as deleteRoute,
  GET as downloadRoute,
  PATCH as renameRoute,
} from '../../app/api/files/[id]/route';
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
  storageObjectName,
  streamToBytes,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { FileResourceSchema } from '@indx-workspace/contracts/files';

import {
  generatedBody,
  MiB,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';
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
import { toResponse } from './http';
import { createRepositoryObjectStoreProvider } from './store';
import { seedCatalogFile } from '@agent-workspace/core/db';

const ACTOR_HEADER = 'x-test-actor';

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  readonly b: Member;
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
  isolated = await createIsolatedTestDatabase('aw_files_list_download');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(() => {
  clearApplicationContext();
});

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`list and download on the ${name}`, () => {
    let world: World;
    let objects: ObjectStore;
    let storage: StorageService;
    const legacy = createInMemoryObjectStoreProvider();

    /** Install the files runtime over the catalog service; `objects` may be wrapped by a test. */
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

    // @story US-STO-01
    // @story US-STO-05
    it('[US-STO-01][api][sdk] a file saved under the new naming downloads and appears in the list', async () => {
      const row = await save('reports/q3.txt', 'quarter three');
      expect(row.objectId).not.toBeNull();

      const files = await listed('a', 'reports');
      expect(files).toEqual([
        expect.objectContaining({
          id: row.id,
          path: 'reports/q3.txt',
          kind: 'file',
          sizeBytes: 13,
        }),
      ]);

      const response = await download('a', 'reports/q3.txt');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('quarter three');

      expect((await download('b', 'reports/q3.txt')).status).toBe(404);
      expect(await listed('b', 'reports')).toEqual([]);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] list shows only ready files', async () => {
      await save('docs/ready.txt', 'ready');
      await save('docs/gone.txt', 'gone');
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      await catalog.remove('docs/gone.txt');
      await catalog.reserve('docs/pending.txt', {
        ownerPrincipalId: world.a.principalId,
        sizeBytes: 3,
        contentType: null,
        objectId: crypto.randomUUID(),
        area: 'files',
      });

      expect((await listed('a', 'docs')).map((file) => file.path)).toEqual(['docs/ready.txt']);
      expect((await download('a', 'docs/pending.txt')).status).toBe(404);
      expect((await download('a', 'docs/gone.txt')).status).toBe(404);
      expect(await listed('b', 'docs')).toEqual([]);
      expect((await download('b', 'docs/ready.txt')).status).toBe(404);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] list shows one level, with explicit and implied folders', async () => {
      await save('docs/a.txt', 'a');
      await save('docs/sub/b.txt', 'b');
      await save('top.txt', 't');
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      await seedCatalogFile(catalog, {
        path: 'empty',
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: world.a.principalId,
      });

      const root = await listed('a');
      expect(root.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
        'file:top.txt',
        'folder:docs',
        'folder:empty',
      ]);
      const docs = await listed('a', 'docs');
      expect(docs.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
        'file:docs/a.txt',
        'folder:docs/sub',
      ]);
      expect(await listed('b')).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] download is a streamed attachment with nosniff', async () => {
      await save('pages/index.html', '<script>alert(1)</script>');

      const response = await download('a', 'pages/index.html');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment; filename="index\.html"/u,
      );
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-length')).toBe('25');
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(await response.text()).toBe('<script>alert(1)</script>');
      expect((await download('b', 'pages/index.html')).status).toBe(404);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a member cannot read a visitor attachment, and a folder answers its metadata', async () => {
      const visitor = '.attachments/33333333-3333-4333-8333-333333333333/scan.txt';
      await save(visitor, 'visitor');
      await save('docs/a.txt', 'a');

      expect((await download('a', visitor)).status).toBe(404);
      expect((await listed('a')).map((entry) => entry.path)).toEqual(['docs']);
      expect((await list('a', '.attachments')).status).toBe(404);

      const folder = await download('a', 'docs');
      expect(folder.status).toBe(200);
      expect(
        FileResourceSchema.parse(((await folder.json()) as { file: unknown }).file),
      ).toMatchObject({
        path: 'docs',
        kind: 'folder',
      });
      expect((await download('b', 'docs')).status).toBe(404);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] the files API hides skill rows by area and keeps a user file under .skills/', async () => {
      const saved = await storage.save(ctxOf(world.a), {
        area: 'skills',
        path: '.skills/demo/SKILL.md',
        maxBytes: 1024,
        replace: true,
        body: bytesToStream(bytesOf('# demo')),
      });
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      // A file a user saved under `.skills/` before the root was reserved.
      await save('.skills/notes.txt', 'notes');
      await save('docs/a.txt', 'a');
      const skill = '.skills/demo/SKILL.md';
      const headers = { [ACTOR_HEADER]: 'a', 'content-type': 'application/json' };
      const idRequest = (path: string, method: string, body?: unknown, query = '') =>
        [
          new Request(`https://example.invalid/api/files/${encodeFileId(path)}${query}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          { params: Promise.resolve({ id: encodeFileId(path) }) },
        ] as const;

      expect((await listed('a')).map((entry) => entry.path)).toEqual(['.skills', 'docs']);
      expect((await listed('a', '.skills')).map((entry) => entry.path)).toEqual([
        '.skills/notes.txt',
      ]);
      expect((await listed('a', '.skills/demo')).map((entry) => entry.path)).toEqual([]);
      const notes = await download('a', '.skills/notes.txt');
      expect(notes.status).toBe(200);
      expect(await notes.text()).toBe('notes');
      expect((await download('a', skill)).status).toBe(404);

      // A skill row moves only through /api/skills: neither it nor a folder holding it moves here.
      expect(
        (await renameRoute(...idRequest(skill, 'PATCH', { newPath: 'moved.md' }))).status,
      ).toBe(400);
      expect(
        (await renameRoute(...idRequest('.skills/demo', 'PATCH', { newPath: 'demo' }))).status,
      ).toBe(400);
      expect(
        (await deleteRoute(...idRequest('.skills', 'DELETE', undefined, '?recursive=true'))).status,
      ).toBe(400);
      expect((await deleteRoute(...idRequest(skill, 'DELETE'))).status).toBe(204);

      // No new path under `.skills/`: not by upload, not by rename into it.
      const upload = await uploadRoute(
        new Request('https://example.invalid/api/files', {
          method: 'POST',
          headers: { [ACTOR_HEADER]: 'a', 'x-file-path': '.skills/new.txt' },
          body: 'new',
        }),
      );
      expect(upload.status).toBe(400);
      expect(
        (await renameRoute(...idRequest('docs/a.txt', 'PATCH', { newPath: '.skills/demo/x.md' })))
          .status,
      ).toBe(400);
      expect((await storage.list(ctxOf(world.a), 'skills', '.skills/demo')).rows).toHaveLength(1);

      // The user's own file renames out, and deletes.
      expect(
        (await renameRoute(...idRequest('.skills/notes.txt', 'PATCH', { newPath: 'notes.txt' })))
          .status,
      ).toBe(200);
      expect(await (await download('a', 'notes.txt')).text()).toBe('notes');
      expect((await deleteRoute(...idRequest('notes.txt', 'DELETE'))).status).toBe(204);
      expect((await download('a', 'notes.txt')).status).toBe(404);
    });

    // @story US-STO-05
    it('[US-STO-05][load][sdk] a 60 MiB download keeps server memory growth under 16 MiB', async () => {
      const size = 60 * MiB;
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      const objectId = crypto.randomUUID();
      const reserved = await catalog.reserve('big/60mib.bin', {
        ownerPrincipalId: world.a.principalId,
        sizeBytes: size,
        contentType: 'application/octet-stream',
        objectId,
        area: 'files',
      });
      await catalog.confirm(reserved.row, {
        sizeBytes: size,
        contentType: 'application/octet-stream',
      });
      const name = storageObjectName(world.a.workspaceId, 'files', objectId);
      const inner = createInMemoryObjectStore();
      // Built before each baseline: the generator's 16 MiB ring is the source, not the download
      // path, so allocating it inside the window read exactly 16 MiB of growth (CI run 39910900763).
      let source = generatedBody(size);
      install({
        ...inner,
        read: (key, options) =>
          key === name
            ? Promise.resolve({
                meta: {
                  sizeBytes: size,
                  contentType: null,
                  etag: 'generated',
                  lastModified: new Date(),
                },
                range: null,
                body: source.body,
              })
            : inner.read(key, options),
      });

      const drain = async (response: Response, sample: () => void): Promise<number> => {
        let seen = 0;
        if (response.body === null) throw new Error('the response has no body');
        for await (const chunk of response.body) {
          const before = seen;
          seen += chunk.byteLength;
          if (Math.floor(seen / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
        }
        return seen;
      };

      await warmHttpTransport();
      const streamed = await peakRssGrowth(async (sample) => {
        const response = await download('a', 'big/60mib.bin');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-length')).toBe(String(size));
        expect(await drain(response, sample)).toBe(size);
      });
      expect(streamed).toBeLessThan(16 * MiB);

      // Negative control: the same body buffered whole and sent as the binary arm must read high.
      source = generatedBody(size);
      const buffered = await peakRssGrowth(async (sample) => {
        const opened = await storage.open(ctxOf(world.a), reserved.row);
        if (opened === null) throw new Error('the object did not open');
        const bytes = await streamToBytes(opened.body);
        sample();
        const response = toResponse({
          status: 200,
          kind: 'binary',
          body: bytes,
          contentType: 'application/octet-stream',
          filename: '60mib.bin',
        });
        expect(await drain(response, sample)).toBe(size);
      });
      expect(buffered).toBeGreaterThanOrEqual(16 * MiB);
    }, 120_000);
  });
}

defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
