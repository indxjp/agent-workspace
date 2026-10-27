/**
 * `POST /api/files` saves through the catalog service (the storage design, §04 "Saving a file"):
 * the body streams to the object store under a new id, the row is confirmed with its checksum, and
 * a folder is a catalog row with no marker object. Driven with real `Request` objects on the
 * in-memory catalog and on PostgreSQL.
 */
// @story US-STO-01
// @story US-STO-14
import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';
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
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';
import { FileResourceSchema, MAX_UPLOAD_BYTES } from '@indx-workspace/contracts/files';

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
import { createStorageService } from '../storage/service';
import { createRepositoryObjectStoreProvider } from './store';

const ACTOR_HEADER = 'x-test-actor';

/** `a` owns workspace A; `v` is its viewer; `c` is another admin of it; `b` owns workspace B. */
type Actor = 'a' | 'v' | 'c' | 'b';

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
}

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  readonly b: Member;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
/** A body that stays open until `finish`, to hold an upload between its steps. */
function heldBody(first: Uint8Array) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(first);
    },
  });
  return { body, finish: (rest: Uint8Array) => (controller.enqueue(rest), controller.close()) };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function memoryWorld(): Promise<World> {
  const a = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID() };
  const b = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID() };
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
  return { workspaceId, principalId };
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
  isolated = await createIsolatedTestDatabase('aw_files_upload_route');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(() => {
  clearApplicationContext();
});

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`upload on the ${name}`, () => {
    let world: World;
    let objects: ObjectStoreV2;
    const legacy = createInMemoryObjectStoreProvider();

    /** Install the files runtime over the catalog service. */
    function install(root: ObjectStoreV2): void {
      objects = root;
      const storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects,
        legacy: { files: legacy },
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
      (await objects.listPrefix(`workspaces/${world.a.workspaceId}/files`)).map(
        (entry) => entry.key,
      );

    // @story US-STO-01
    it('[US-STO-01][api][sdk] an uploaded file has a ready row with its SHA-256 and lives under workspaces/<ws>/files/<objectId>', async () => {
      const bytes = bytesOf('quarter three');
      const response = await post('reports/q3.pdf', bytes);
      expect(response.status, await response.clone().text()).toBe(201);
      const { file } = (await response.json()) as { file: unknown };
      expect(FileResourceSchema.parse(file)).toMatchObject({
        path: 'reports/q3.pdf',
        kind: 'file',
        sizeBytes: bytes.byteLength,
      });

      const row = await (await catalogA()).get('reports/q3.pdf');
      expect(row).toMatchObject({ status: 'ready', sha256: sha256Of(bytes) });
      expect((file as { id: string }).id).toBe(row?.id);
      const objectId = row?.objectId ?? null;
      if (objectId === null) throw new Error('the row has no object id');
      const stored = storageObjectName(world.a.workspaceId, 'files', objectId);
      expect(await objects.head(stored)).not.toBeNull();
      expect(await legacy.forWorkspace(world.a.workspaceId).get('reports/q3.pdf')).toBeNull();

      const refused = await post('reports/other.pdf', bytes, 'v');
      expect(refused.status).toBe(403);
      expect(
        await (await catalogA()).get('reports/other.pdf', { includePending: true }),
      ).toBeNull();
      expect(await filesObjects()).toEqual([stored]);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] a body over MAX_UPLOAD_BYTES with no Content-Length is 413 and the previous version stays', async () => {
      const first = bytesOf('first version');
      expect((await post('big.bin', first)).status).toBe(201);
      const before = await (await catalogA()).get('big.bin');
      const objectsBefore = await filesObjects();

      const response = await post('big.bin', generatedBody(MAX_UPLOAD_BYTES + 1).body);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: 'request_body_too_large' } });

      const after = await (await catalogA()).get('big.bin');
      expect(after).toMatchObject({
        id: before?.id,
        objectId: before?.objectId,
        sha256: sha256Of(first),
      });
      expect(await filesObjects()).toEqual(objectsBefore);
      expect(await (await catalogA()).get('big.bin', { includePending: true })).toMatchObject({
        status: 'ready',
      });

      const declared = await post('big.bin', first, 'a', {
        'content-length': String(MAX_UPLOAD_BYTES + 1),
      });
      expect(declared.status).toBe(413);
      expect((await post('big.bin', first, 'v')).status).toBe(403);
      expect(await filesObjects()).toEqual(objectsBefore);
    }, 120_000);

    // @story US-STO-14
    it('[US-STO-14][api][sdk] a second upload to a path being uploaded is 409 for the same member and another; the first still lands', async () => {
      const held = heldBody(bytesOf('first '));
      const winner = post('race.txt', held.body);
      await vi.waitFor(async () =>
        expect(await (await catalogA()).get('race.txt', { includePending: true })).toMatchObject({
          status: 'pending',
        }),
      );

      for (const actor of ['a', 'c'] as const) {
        const loser = await post('race.txt', bytesOf('second'), actor);
        expect(loser.status).toBe(409);
        expect(await loser.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
      }
      expect((await post('race.txt', bytesOf('second'), 'v')).status).toBe(403);

      held.finish(bytesOf('done'));
      const response = await winner;
      expect(response.status).toBe(201);
      expect(await (await catalogA()).get('race.txt')).toMatchObject({
        status: 'ready',
        sha256: sha256Of(bytesOf('first done')),
      });
      expect(await filesObjects()).toHaveLength(1);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] a folder is a catalog row with no marker object, listed by GET, and a second create is 409', async () => {
      const response = await postFolder('docs/specs');
      expect(response.status, await response.clone().text()).toBe(201);
      expect(
        FileResourceSchema.parse(((await response.json()) as { file: unknown }).file),
      ).toMatchObject({ path: 'docs/specs', kind: 'folder' });
      expect(await (await catalogA()).get('docs/specs')).toMatchObject({
        kind: 'folder',
        status: 'ready',
      });
      expect(await filesObjects()).toEqual([]);
      expect((await listed('docs')).map((file) => file.path)).toEqual(['docs/specs']);

      const again = await postFolder('docs/specs');
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: 'name_conflict' } });

      const onFolder = await post('docs/specs', bytesOf('x'));
      expect(onFolder.status).toBe(409);
      expect(await onFolder.json()).toMatchObject({ error: { code: 'name_conflict' } });
      expect(await (await catalogA()).get('docs/specs')).toMatchObject({ kind: 'folder' });
      expect(await filesObjects()).toEqual([]);

      expect((await post('docs/file.txt', bytesOf('x'))).status).toBe(201);
      expect((await postFolder('docs/file.txt')).status).toBe(409);
      expect((await postFolder('docs/other', 'v')).status).toBe(403);
      expect(await (await catalogA()).get('docs/other')).toBeNull();
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] a folder over a path being uploaded is 409 upload_in_progress', async () => {
      const held = heldBody(bytesOf('x'));
      const upload = post('busy', held.body);
      await vi.waitFor(async () =>
        expect(await (await catalogA()).get('busy', { includePending: true })).not.toBeNull(),
      );

      const folder = await postFolder('busy');
      expect(folder.status).toBe(409);
      expect(await folder.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
      expect((await postFolder('busy', 'v')).status).toBe(403);

      held.finish(bytesOf('y'));
      expect((await upload).status).toBe(201);
    });

    // @story US-STO-01
    it.each([
      ['../x', 'invalid_path'],
      ['%aside/x', 'invalid_path'],
      ['.claude/x', 'reserved_path'],
    ])(
      '[US-STO-01][api][sdk] the path %j is refused with %s and nothing is written',
      async (path, code) => {
        const response = await post(path, bytesOf('x'));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code } });
        const folder = await postFolder(path);
        expect(folder.status).toBe(400);
        expect((await post(path, bytesOf('x'), 'v')).status).toBe(403);
        expect(await filesObjects()).toEqual([]);
        expect(await (await catalogA()).listFiles()).toEqual([]);
      },
    );

    // @story US-STO-01
    it('[US-STO-01][api][sdk] a workspace B member cannot see or replace workspace A rows through its own upload', async () => {
      expect((await post('shared.txt', bytesOf('a side'))).status).toBe(201);
      expect((await post('shared.txt', bytesOf('b side'), 'b')).status).toBe(201);
      expect(await (await catalogA()).get('shared.txt')).toMatchObject({
        sha256: sha256Of(bytesOf('a side')),
      });
      expect(
        await (await world.catalogs.forWorkspace(world.b.workspaceId)).get('shared.txt'),
      ).toMatchObject({ sha256: sha256Of(bytesOf('b side')) });
    });

    // @story US-STO-05
    it('[US-STO-05][load][sdk] a 60 MiB upload keeps server memory growth under 16 MiB', async () => {
      const size = 60 * MiB;
      const inner = createInMemoryObjectStore();
      let sample: () => void = () => undefined;
      // Drains the body instead of keeping it, so what the window reads is the route and the
      // service, not the test's own store.
      install({
        ...inner,
        write: async (_key, body) => {
          let seen = 0;
          if (body instanceof Uint8Array) {
            seen = body.byteLength;
          } else {
            for await (const chunk of body) {
              const before = seen;
              seen += chunk.byteLength;
              if (Math.floor(seen / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
            }
          }
          return { sizeBytes: seen, contentType: null, etag: 'drained', lastModified: new Date() };
        },
      });

      // Built before each baseline: the generator's 16 MiB ring is the source, not the route.
      let source = generatedBody(size);
      await warmHttpTransport();
      const streamed = await peakRssGrowth(async (sampled) => {
        sample = sampled;
        const response = await post('big/60mib.bin', source.body);
        expect(response.status, await response.clone().text()).toBe(201);
      });
      expect(streamed).toBeLessThan(16 * MiB);
      expect(await (await catalogA()).get('big/60mib.bin')).toMatchObject({
        sizeBytes: size,
        sha256: await source.sha256,
      });
      expect((await post('big/viewer.bin', generatedBody(MiB).body, 'v')).status).toBe(403);

      // Negative control: buffering the same body whole, as the legacy route did, must read high.
      source = generatedBody(size);
      const buffered = await peakRssGrowth(async (sampled) => {
        const init = { method: 'POST', body: source.body, duplex: 'half' as const };
        const read = await new Request('https://example.invalid/api/files', init).arrayBuffer();
        sampled();
        expect(read.byteLength).toBe(size);
      });
      expect(buffered).toBeGreaterThanOrEqual(16 * MiB);
    }, 120_000);
  });
}

defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
