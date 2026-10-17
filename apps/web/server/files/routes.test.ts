/**
 * The files route handlers, imported as Next.js will import them and driven with real `Request`
 * objects. Mirrors `apps/web/server/agents/routes.test.ts`'s shape — see that file's header for
 * why a header-driven test resolver is the strongest position to give an attacker, and what this
 * file cannot exercise (Next.js's own routing — `tests/route-inventory.test.ts` covers that).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resourcePathHeaders } from '../../contracts/files';
import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';
import {
  DELETE as deleteRoute,
  GET as downloadRoute,
  PATCH as renameRoute,
} from '../../app/api/files/[id]/route';
import { encodeFileId } from './file-id';
import { createRepositoryObjectStoreProvider } from './store';
import { createLocalFilesystemObjectStoreProvider } from './object-store-bridge';
import { clearFilesRuntime, configureFilesRuntime, type WorkspaceResolution } from './runtime';
import { createResourceCatalogStoreProvider } from '../resources/catalog-store';
import {
  createInMemoryWorkspaceScopeResolver,
  openDatabaseRoot,
  type DatabaseRoot,
} from '@agent-workspace/core/db';
import {
  apiKeys,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { createPostgresDirectory } from '../rbac/postgres-directory';
import { Principal } from '../rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../rbac/runtime';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_HEADER = 'x-test-workspace';
/** issue #117: which seeded member a request authenticates as, in the DB-backed suite below. */
const ACTOR_HEADER = 'x-test-actor';
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-routes-'));
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE_A, slug: 'acme' },
    { id: WORKSPACE_B, slug: 'globex' },
  ]);
  const store = createRepositoryObjectStoreProvider({
    store: createLocalFilesystemObjectStoreProvider(rootDir),
    scopes,
  });
  configureFilesRuntime({
    store,
    resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      if (workspaceId === null) {
        return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
      }
      return Promise.resolve({ kind: 'workspace', workspaceId });
    },
  });
  configureRbacRuntime({
    // Issue #117: every create/sync path resolves `created_by`, falling back to the workspace's
    // oldest Owner when the caller cannot be matched by email (true of every request here, which
    // authenticates as an API key) — so each fixture workspace needs at least one seeded member.
    directory: createMemoryDirectory({
      users: [
        {
          email: 'owner-a@example.test',
          name: 'Owner A',
          workspaceId: WORKSPACE_A,
          role: 'owner',
        },
        {
          email: 'owner-b@example.test',
          name: 'Owner B',
          workspaceId: WORKSPACE_B,
          role: 'owner',
        },
      ],
    }),
    identify(request: Request) {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? null
          : Principal.fromApiKey({
              principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
              apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              workspaceId,
              role: 'owner',
              label: 'Files route test key',
            }),
      );
    },
  });
});

afterEach(async () => {
  clearFilesRuntime();
  clearRbacRuntime();
  await rm(rootDir, { recursive: true, force: true });
});

function req(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: BodyInit;
    contentType?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.contentType !== undefined && options.contentType !== null) {
    headers.set('content-type', options.contentType);
  }
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('files routes, unconfigured', () => {
  it('answers 503, not 401 and not an empty 200, while nothing is wired', async () => {
    clearFilesRuntime(); // this suite's beforeEach already configured one — undo it for this case
    const response = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'files_runtime_not_configured' },
    });
  });
});

describe('POST /api/files then GET /api/files', () => {
  it('uploads a file and lists it back with its metadata', async () => {
    const upload = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode('# hello\n'),
        headers: { 'x-file-path': 'instructions.md' },
        contentType: 'text/markdown',
      }),
    );
    expect(upload.status, await upload.clone().text()).toBe(201);
    const uploaded = (await upload.json()) as { file: { id: string; path: string } };
    expect(uploaded.file.path).toBe('instructions.md');

    const list = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { files: Array<{ path: string; id: string }> };
    expect(body.files.map((f) => f.path)).toEqual(['instructions.md']);
    expect(body.files[0]?.id).toBe(uploaded.file.id);
  });

  it('requires the x-file-path header', async () => {
    const response = await uploadRoute(
      req('POST', '/api/files', { workspace: WORKSPACE_A, body: new Uint8Array([1]) }),
    );
    expect(response.status).toBe(400);
  });

  it('accepts a percent-encoded UTF-8 filename from the browser and lists the original path', async () => {
    const filePath = '案件/見積書_日本語.txt';
    const upload = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode('日本語の本文'),
        headers: resourcePathHeaders('x-file-path', filePath),
        contentType: 'text/plain',
      }),
    );

    expect(upload.status, await upload.clone().text()).toBe(201);
    expect(await upload.json()).toMatchObject({ file: { path: filePath } });

    const list = await listRoute(
      req('GET', '/api/files?path=%E6%A1%88%E4%BB%B6', { workspace: WORKSPACE_A }),
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ files: [{ path: filePath }] });
  });
});

describe('POST /api/files when the catalog write fails', () => {
  /** The default harness wires no catalog, so the compensation is unreachable without one. */
  function useCatalog(putFile: () => Promise<{ id: string }>): void {
    const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_A, slug: 'acme' }]);
    configureFilesRuntime({
      store: createRepositoryObjectStoreProvider({
        store: createLocalFilesystemObjectStoreProvider(rootDir),
        scopes,
      }),
      catalog: {
        forWorkspace: () =>
          Promise.resolve({ putFile } as unknown as Awaited<
            ReturnType<
              NonNullable<Parameters<typeof configureFilesRuntime>[0]['catalog']>['forWorkspace']
            >
          >),
      },
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
    });
  }

  function put(filePath: string, text: string): Promise<Response> {
    return uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode(text),
        headers: { 'x-file-path': filePath },
        contentType: 'text/plain',
      }),
    );
  }

  const objectStore = (): ReturnType<
    ReturnType<typeof createLocalFilesystemObjectStoreProvider>['forWorkspace']
  > => createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A);

  it('keeps an overwritten file when the catalog write fails', async () => {
    useCatalog(() => Promise.resolve({ id: 'row-1' }));
    expect((await put('a.txt', 'v1')).status).toBe(201);

    useCatalog(() => Promise.reject(new Error('database blip')));
    // The route rethrows; Next.js turns the unhandled error into the 500.
    await expect(put('a.txt', 'v2')).rejects.toThrow('database blip');

    const kept = await objectStore().get('a.txt');
    expect(new TextDecoder().decode(kept?.body)).toBe('v2');
  });

  it('removes a new file when the catalog write fails', async () => {
    useCatalog(() => Promise.reject(new Error('database blip')));
    await expect(put('fresh.txt', 'v1')).rejects.toThrow('database blip');

    expect(await objectStore().get('fresh.txt')).toBeNull();
  });
});

describe('GET/DELETE/PATCH /api/files/:id', () => {
  async function uploadAndGetId(
    workspace: string,
    filePath: string,
    text: string,
  ): Promise<string> {
    const response = await uploadRoute(
      req('POST', '/api/files', {
        workspace,
        body: new TextEncoder().encode(text),
        headers: { 'x-file-path': filePath },
      }),
    );
    const body = (await response.json()) as { file: { id: string } };
    return body.file.id;
  }

  it('downloads exactly the uploaded bytes', async () => {
    const id = await uploadAndGetId(WORKSPACE_A, 'a.txt', 'hello\n');
    const response = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('hello\n', 'utf8'));
  });

  it('renames a file, and the old id 404s afterward', async () => {
    const id = await uploadAndGetId(WORKSPACE_A, 'a.txt', 'x');
    const rename = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ newPath: 'b.txt' }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(rename.status, await rename.clone().text()).toBe(200);
    expect(
      (
        await downloadRoute(
          req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
          idContext(id),
        )
      ).status,
    ).toBe(404);
    const newId = encodeFileId('b.txt');
    expect(
      (
        await downloadRoute(
          req('GET', `/api/files/${newId}`, { workspace: WORKSPACE_A }),
          idContext(newId),
        )
      ).status,
    ).toBe(200);
  });

  it('deletes a file', async () => {
    const id = await uploadAndGetId(WORKSPACE_A, 'a.txt', 'x');
    expect(
      (
        await deleteRoute(
          req('DELETE', `/api/files/${id}`, { workspace: WORKSPACE_A }),
          idContext(id),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await downloadRoute(
          req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
          idContext(id),
        )
      ).status,
    ).toBe(404);
  });

  it("one workspace cannot download, rename or delete a file by another workspace's id", async () => {
    const idInA = await uploadAndGetId(WORKSPACE_A, 'secret.txt', 'top secret');

    const download = await downloadRoute(
      req('GET', `/api/files/${idInA}`, { workspace: WORKSPACE_B }),
      idContext(idInA),
    );
    expect(download.status).toBe(404);

    const del = await deleteRoute(
      req('DELETE', `/api/files/${idInA}`, { workspace: WORKSPACE_B }),
      idContext(idInA),
    );
    expect(del.status).toBe(204); // ObjectStore delete is idempotent; nothing in B was ever there

    // Proof the file in A is untouched by B's no-op delete.
    const stillThere = await downloadRoute(
      req('GET', `/api/files/${idInA}`, { workspace: WORKSPACE_A }),
      idContext(idInA),
    );
    expect(stillThere.status).toBe(200);

    const rename = await renameRoute(
      req('PATCH', `/api/files/${idInA}`, {
        workspace: WORKSPACE_B,
        body: JSON.stringify({ newPath: 'stolen.txt' }),
        contentType: 'application/json',
      }),
      idContext(idInA),
    );
    expect(rename.status).toBe(404);
  });
});

/**
 * The four counter-examples W2-CP-03's verification round 1 built and ran against these very route
 * handlers, kept as tests so the defects they found cannot come back. Each one is the verifier's
 * own reproduction, not a paraphrase of it.
 */
describe('verification round 1 counter-examples, driven through the real route handlers', () => {
  async function post(filePath: string, body: string, contentType?: string): Promise<Response> {
    return uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode(body),
        headers: { 'x-file-path': filePath },
        ...(contentType === undefined ? {} : { contentType }),
      }),
    );
  }

  it('F2: a doubly-encoded path is refused, and does not overwrite the object it used to decode to', async () => {
    expect((await post('a/b', 'VICTIM BYTES')).status).toBe(201);

    const attack = await post('a%252fb', 'ATTACKER BYTES');
    expect(attack.status).toBe(400);
    expect(await attack.json()).toMatchObject({ error: { code: 'invalid_path' } });

    // The victim is untouched, and still reachable under its own id and its own path.
    const victimId = encodeFileId('a/b');
    const download = await downloadRoute(
      req('GET', `/api/files/${victimId}`, { workspace: WORKSPACE_A }),
      idContext(victimId),
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('VICTIM BYTES');

    const listed = await listRoute(req('GET', '/api/files?path=a', { workspace: WORKSPACE_A }));
    const body = (await listed.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(['a/b']);
  });

  it("F3: a key naming the metadata sidecar is refused in every spelling, so no uploader can choose another file's content type", async () => {
    expect((await post('note.txt', 'hello', 'text/plain')).status).toBe(201);

    // Round 2 closed only the first of these. Round 3 re-ran the whole of F3's evidence through
    // this same route with the second one and got a `201`, a forged content type on the victim,
    // and a listing that hid the file it had just created — because this route's filesystem folds
    // case. Every spelling that a folding namespace resolves to the sidecar is asserted here.
    const spellings = [
      'note.txt.__objectstore_meta__.json',
      'note.txt.__objectstore_meta__.JSON',
      'note.txt.__ObjectStore_Meta__.json',
      'NOTE.TXT.__OBJECTSTORE_META__.JSON',
      'note.txt.__objectstore_meta__.json::$DATA',
      'note.txt.%__objectstore_meta__%.json',
    ];
    for (const spelling of spellings) {
      const forge = await post(spelling, '{"contentType":"text/html"}');
      expect(forge.status, `POST ${spelling}`).toBe(400);
      expect(await forge.json()).toMatchObject({ error: { code: 'invalid_path' } });
    }

    const id = encodeFileId('note.txt');
    const download = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(download.headers.get('content-type')).toBe('text/plain');

    // And the listing is complete: `list()` filters nothing at all now, so there is no filter for
    // a stored file to hide behind.
    const listed = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    const body = (await listed.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(['note.txt']);
  });

  it('B1: the NTFS 8.3 alias of a sidecar is an ordinary file, forges nothing, and is listed', async () => {
    // Verification round 4's counter-example, end to end. `NOTETX~1.JSO` was the short name NTFS
    // minted for `note.txt`'s sidecar when sidecars lived beside their objects: it contains no
    // marker and no `%`, so it was a legal key, and posting it forged the content type this route
    // reported for `note.txt` while being absent from its own listing. Metadata now lives in a
    // tree no key resolves into, so this key is simply a file called `NOTETX~1.JSO`.
    //
    // The name is asserted as a legal key rather than refused on purpose: refusing it would be
    // another spelling rule, and a spelling rule is what failed three times.
    expect((await post('note.txt', 'hello', 'text/plain')).status).toBe(201);
    expect((await post('NOTETX~1.JSO', '{"contentType":"text/html"}')).status).toBe(201);

    const id = encodeFileId('note.txt');
    const download = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(download.headers.get('content-type')).toBe('text/plain');
    expect(await download.text()).toBe('hello');

    const listed = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    const body = (await listed.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path).sort()).toEqual(['NOTETX~1.JSO', 'note.txt']);
  });

  it('B1: an upload whose sidecar cannot be written still answers 201, and the file it wrote is readable', async () => {
    // Verification round 5's two-POST reproduction, kept as a test. On NTFS the second key's
    // metadata *directory* collides with the first key's sidecar *file* through that file's 8.3
    // alias, and `put` used to let the resulting EEXIST out of the route as a framework 500 —
    // with the upload already on disk. The store now treats the sidecar as best effort, so this
    // answers 201 and the content type is simply unknown.
    expect((await post('note.txt', 'hello', 'text/plain')).status).toBe(201);
    const upload = await post('NOTETX~1.JSO/x.txt', 'PAYLOAD', 'text/html');
    expect(upload.status).toBe(201);

    const id = encodeFileId('NOTETX~1.JSO/x.txt');
    const download = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('PAYLOAD');

    // The victim is untouched, and both uploads are listed under their own paths.
    const victimId = encodeFileId('note.txt');
    const victim = await downloadRoute(
      req('GET', `/api/files/${victimId}`, { workspace: WORKSPACE_A }),
      idContext(victimId),
    );
    expect(victim.headers.get('content-type')).toBe('text/plain');
    const listed = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    const body = (await listed.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path).sort()).toEqual(['NOTETX~1.JSO', 'note.txt']);
  });

  it('F4: an uploaded script is not served back as active content from this origin', async () => {
    const payload = '<script>alert(document.domain)</script>';
    expect((await post('pwn.txt', payload, 'text/html')).status).toBe(201);

    const id = encodeFileId('pwn.txt');
    const download = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(download.status).toBe(200);
    // The bytes are returned unchanged — this is a delivery fix, not a sanitising one.
    expect(await download.clone().text()).toBe(payload);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="pwn.txt"; filename*=UTF-8''pwn.txt`,
    );
  });

  it('F4b: a filename that could break the Content-Disposition quoting cannot', async () => {
    // `;` is the parameter separator this header is built from, and a space ends an unquoted
    // token: between them they are the injection shape a naive builder would fall to. (A control
    // character cannot get this far — `key-safety.ts` refuses one outright. A `\"` cannot be
    // stored by the local-filesystem backend on Windows at all, which is a carried gap declared on
    // this PR, not something this test can drive.)
    const name = 'a;b, c.txt';
    expect((await post(name, 'x')).status).toBe(201);
    const id = encodeFileId(name);
    const download = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    const disposition = download.headers.get('content-disposition') ?? '';
    expect(disposition).toBe(
      `attachment; filename="a_b__c.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    // One quoted string, one `filename*`: the caller's punctuation did not open a parameter.
    expect(disposition.split('"').length - 1).toBe(2);
  });

  it('F5: an input the guard refuses is a 400 invalid_path, never an uncaught 500', async () => {
    const response = await post('%252e%252e%252fx', 'x');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_path' } });
  });

  it('every response carries nosniff, not only the binary one', async () => {
    const listed = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(listed.headers.get('x-content-type-options')).toBe('nosniff');
    const id = await (async (): Promise<string> => {
      await post('gone.txt', 'x');
      return encodeFileId('gone.txt');
    })();
    const deleted = await deleteRoute(
      req('DELETE', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

/**
 * Verification round 2, finding 1: `ownershipOfPath` (`apps/web/app/api/files/[id]/route.ts`)
 * compares a file's catalog `created_by` against the caller, but every test above runs as an
 * Owner, whose grant on `files` is `any` (`permissions.ts`) — wide enough that `decide()` never
 * even looks at what `ownershipOfPath` answered. This suite drives the same three routes as a
 * Builder, whose grant is `own`, so the comparison is the thing standing between the two Builders
 * below.
 *
 * The comparison reads a real `ResourceCatalogRepository` (`created_by` is tenant-paired to
 * `memberships` by a composite foreign key — see `packages/core/src/db/schema/files.ts`), and
 * there is no in-memory implementation of that repository anywhere in the tree (only
 * `createDatabaseResourceCatalogRepositoryProvider`, over PostgreSQL). So this suite needs a real
 * `TEST_DATABASE_URL` and skips loudly, rather than being marked `.skip`, when one is not set —
 * the same `describe.skipIf` shape `resource-catalogs.test.ts` and `postgres-directory.test.ts`
 * use, so CI's real PostgreSQL 17 is the authority on whether it ran.
 */
describe.skipIf(!hasDatabase)(
  'own/other ownership on GET/DELETE/PATCH /api/files/:id (issue #117, PostgreSQL-backed)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let dbRootDir: string;
    const workspace = {
      id: crypto.randomUUID(),
      slug: 'w9-117-files-ownership',
      name: 'Files ownership',
    };
    const builderA = {
      id: crypto.randomUUID(),
      email: 'builder-a@example.test',
      name: 'Builder A',
    };
    const builderB = {
      id: crypto.randomUUID(),
      email: 'builder-b@example.test',
      name: 'Builder B',
    };
    const apiKeyAId = 'd4b86567-2c98-42e4-8c51-dab76a07f61e';
    const apiKeyBId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const principalAId = '79e2e118-56c7-4f54-96c5-e942b24de9b7';
    const principalBId = 'f54eceb4-80a0-48a5-a3a6-6fd634683f59';

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_files_ownership');
      await isolated.db.insert(workspaces).values(workspace);
      await isolated.db.insert(users).values([builderA, builderB]);
      await isolated.db.insert(memberships).values([
        { workspaceId: workspace.id, userId: builderA.id, role: 'builder' },
        { workspaceId: workspace.id, userId: builderB.id, role: 'builder' },
      ]);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(apiKeys).values([
          {
            id: apiKeyAId,
            workspaceId: workspace.id,
            name: 'Builder A file key',
            role: 'builder',
            keyPrefix: 'ak_file_a',
            keyHash: 'a'.repeat(64),
          },
          {
            id: apiKeyBId,
            workspaceId: workspace.id,
            name: 'Builder B file key',
            role: 'builder',
            keyPrefix: 'ak_file_b',
            keyHash: 'b'.repeat(64),
          },
        ]);
        await tx.insert(workspacePrincipals).values([
          {
            id: principalAId,
            workspaceId: workspace.id,
            kind: 'api_key',
            apiKeyId: apiKeyAId,
          },
          {
            id: principalBId,
            workspaceId: workspace.id,
            kind: 'api_key',
            apiKeyId: apiKeyBId,
          },
        ]);
      });
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    }, 180_000);

    afterAll(async () => {
      await root.close();
      await isolated.close();
    });

    beforeEach(async () => {
      dbRootDir = await mkdtemp(path.join(os.tmpdir(), 'w9-auth-117-files-ownership-'));
      configureFilesRuntime({
        store: createRepositoryObjectStoreProvider({
          store: createLocalFilesystemObjectStoreProvider(dbRootDir),
          scopes: root.scopes,
        }),
        catalog: createResourceCatalogStoreProvider({
          repositories: root.resourceCatalogs,
          scopes: root.scopes,
        }),
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          return Promise.resolve(
            workspaceId === null
              ? { kind: 'unauthenticated', reason: 'no test workspace header' }
              : { kind: 'workspace', workspaceId },
          );
        },
      });
      configureRbacRuntime({
        directory: createPostgresDirectory(root.directory),
        identify(request: Request) {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          const actor = request.headers.get(ACTOR_HEADER);
          return Promise.resolve(
            workspaceId === null || actor === null
              ? null
              : Principal.fromApiKey({
                  principalId: actor === builderA.email ? principalAId : principalBId,
                  apiKeyId: actor === builderA.email ? apiKeyAId : apiKeyBId,
                  workspaceId,
                  role: 'builder',
                  label: actor === builderA.email ? 'Builder A file key' : 'Builder B file key',
                }),
          );
        },
      });
    });

    afterEach(async () => {
      clearFilesRuntime();
      clearRbacRuntime();
      await rm(dbRootDir, { recursive: true, force: true });
    });

    it('a Builder may rename and delete the file it uploaded, and no other Builder may (issue #117)', async () => {
      const upload = await uploadRoute(
        req('POST', '/api/files', {
          workspace: workspace.id,
          body: new TextEncoder().encode('shared bytes'),
          headers: { 'x-file-path': 'shared.txt', [ACTOR_HEADER]: builderA.email },
        }),
      );
      expect(upload.status, await upload.clone().text()).toBe(201);
      const id = encodeFileId('shared.txt');

      // Builder's grant on `files` is `{ read: 'any', write: 'own', run: 'own' }`
      // (`permissions.ts`) — `GET` is readable workspace-wide by design and is not an own/other
      // gate; `PATCH` (rename) and `DELETE` are the writes this task's `ownershipOfPath` stands in
      // front of, and they are what this test proves. Both builders can download the same bytes
      // first, so the denials below are provably about the write verbs, not a workspace mismatch.
      const readByOther = await downloadRoute(
        req('GET', `/api/files/${id}`, {
          workspace: workspace.id,
          headers: { [ACTOR_HEADER]: builderB.email },
        }),
        idContext(id),
      );
      expect(readByOther.status, await readByOther.clone().text()).toBe(200);

      // Builder B did not create this row: `own` is denied, on both write verbs this resolver
      // gates, and `decide()` never sees a role wide enough to substitute for it (Builder's write
      // grant on files is `own`, not `any`).
      const deniedRename = await renameRoute(
        req('PATCH', `/api/files/${id}`, {
          workspace: workspace.id,
          body: JSON.stringify({ newPath: 'stolen.txt' }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: builderB.email },
        }),
        idContext(id),
      );
      expect(deniedRename.status).toBe(403);

      const deniedDelete = await deleteRoute(
        req('DELETE', `/api/files/${id}`, {
          workspace: workspace.id,
          headers: { [ACTOR_HEADER]: builderB.email },
        }),
        idContext(id),
      );
      expect(deniedDelete.status).toBe(403);

      // Builder A did create it: the same routes, the same file, only the caller differs.
      const allowedRename = await renameRoute(
        req('PATCH', `/api/files/${id}`, {
          workspace: workspace.id,
          body: JSON.stringify({ newPath: 'shared-renamed.txt' }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: builderA.email },
        }),
        idContext(id),
      );
      expect(allowedRename.status, await allowedRename.clone().text()).toBe(200);

      const renamedId = encodeFileId('shared-renamed.txt');
      const allowedDelete = await deleteRoute(
        req('DELETE', `/api/files/${renamedId}`, {
          workspace: workspace.id,
          headers: { [ACTOR_HEADER]: builderA.email },
        }),
        idContext(renamedId),
      );
      expect(allowedDelete.status, await allowedDelete.clone().text()).toBe(204);
    });

    it("owning a folder does not let a Builder delete or move another member's file inside it", async () => {
      for (const [actor, file] of [
        [builderA.email, 'team/a.txt'],
        [builderB.email, 'team/b.txt'],
      ] as const) {
        const upload = await uploadRoute(
          req('POST', '/api/files', {
            workspace: workspace.id,
            body: new TextEncoder().encode(file),
            headers: { 'x-file-path': file, [ACTOR_HEADER]: actor },
          }),
        );
        expect(upload.status, await upload.clone().text()).toBe(201);
      }
      // `team` is Builder A's folder row (the first upload under it), but `team/b.txt` is B's.
      const id = encodeFileId('team');
      const deniedDelete = await deleteRoute(
        req('DELETE', `/api/files/${id}?recursive=true`, {
          workspace: workspace.id,
          headers: { [ACTOR_HEADER]: builderA.email },
        }),
        idContext(id),
      );
      expect(deniedDelete.status).toBe(403);
      const deniedMove = await renameRoute(
        req('PATCH', `/api/files/${id}`, {
          workspace: workspace.id,
          body: JSON.stringify({ newPath: 'mine' }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: builderA.email },
        }),
        idContext(id),
      );
      expect(deniedMove.status).toBe(403);

      const bFile = encodeFileId('team/b.txt');
      const stillThere = await downloadRoute(
        req('GET', `/api/files/${bFile}`, {
          workspace: workspace.id,
          headers: { [ACTOR_HEADER]: builderB.email },
        }),
        idContext(bFile),
      );
      expect(stillThere.status).toBe(200);
    });
  },
);
