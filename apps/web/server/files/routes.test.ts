/**
 * The files route handlers, imported as Next.js will import them and driven with real `Request`
 * objects. Mirrors `apps/web/server/agents/routes.test.ts`'s shape — see that file's header for
 * why a header-driven test resolver is the strongest position to give an attacker, and what this
 * file cannot exercise (Next.js's own routing — `tests/route-inventory.test.ts` covers that).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resourcePathHeaders } from '../../contracts/files';
import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';
import {
  DELETE as deleteRoute,
  GET as downloadRoute,
  PATCH as renameRoute,
} from '../../app/api/files/[id]/route';
import { POST as uploadUrlRoute } from '../../app/api/files/[id]/upload-urls/route';
import { encodeFileId } from './file-id';
import { createCatalogFilesWorld, type CatalogFilesWorld } from './catalog-runtime-fixtures';
import { bytesToStream, createInMemoryObjectStore } from '@agent-workspace/core/storage';
import type { WorkspaceResolution } from './runtime';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import {
  openDatabaseRoot,
  type DatabaseRoot,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  apiKeys,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
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
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { seedCatalogFile } from '@agent-workspace/core/db';
import { listCatalogFiles } from '@agent-workspace/core/db';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_HEADER = 'x-test-workspace';
/** issue #117: which seeded member a request authenticates as, in the DB-backed suite below. */
const ACTOR_HEADER = 'x-test-actor';
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** The files runtime of the current test: the catalog service over in-memory stores. */
let world: CatalogFilesWorld;

/** The header-driven resolver the default harness uses: the workspace a test names. */
function resolveWorkspaceFromHeader(request: Request): Promise<WorkspaceResolution> {
  const workspaceId = request.headers.get(WORKSPACE_HEADER);
  if (workspaceId === null) {
    return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
  }
  return Promise.resolve({ kind: 'workspace', workspaceId });
}

const fixedWorkspaceA = (): Promise<WorkspaceResolution> =>
  Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A });

beforeEach(() => {
  world = createCatalogFilesWorld({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE_A, WORKSPACE_B].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: resolveWorkspaceFromHeader,
  });
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  installTestDomains({
    rbac: {
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
    },
  });
});

afterEach(() => {
  clearApplicationContext();
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
    // The role gate lives in the same context, so with none installed it answers first; the files
    // runtime's own answer is the `unavailable` case below.
    clearApplicationContext(); // this suite's beforeEach already configured one — undo it for this case
    const response = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'rbac_runtime_not_configured' },
    });
  });

  it('answers the same 503 when the files storage is unavailable', async () => {
    installTestDomains({ files: { kind: 'unavailable' } });
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
    expect(response.status, await response.clone().text()).toBe(201);
    // The `:id` routes take the path's own id, which is not the catalog row id the upload returns.
    return encodeFileId(filePath);
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
    expect(del.status).toBe(204); // a missing path is an idempotent delete; B's catalog holds no such row

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

  it('two concurrent renames to one destination: one wins, one 409s, no bytes are lost (FX-2)', async () => {
    const idA = await uploadAndGetId(WORKSPACE_A, 'a.txt', 'bytes of a');
    const idB = await uploadAndGetId(WORKSPACE_A, 'b.txt', 'bytes of b');
    const rename = (id: string): Promise<Response> =>
      renameRoute(
        req('PATCH', `/api/files/${id}`, {
          workspace: WORKSPACE_A,
          body: JSON.stringify({ newPath: 'same.txt' }),
          contentType: 'application/json',
        }),
        idContext(id),
      );
    const responses = await Promise.all([rename(idA), rename(idB)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const texts: string[] = [];
    for (const filePath of ['a.txt', 'b.txt', 'same.txt']) {
      const id = encodeFileId(filePath);
      const download = await downloadRoute(
        req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
        idContext(id),
      );
      if (download.status === 200) texts.push(await download.text());
    }
    expect(texts.sort()).toEqual(['bytes of a', 'bytes of b']);
  });

  it('two concurrent renames of one source: one wins, the other finds nothing to move (FX-2)', async () => {
    const id = await uploadAndGetId(WORKSPACE_A, 'src.txt', 'bytes of src');
    const rename = (newPath: string): Promise<Response> =>
      renameRoute(
        req('PATCH', `/api/files/${id}`, {
          workspace: WORKSPACE_A,
          body: JSON.stringify({ newPath }),
          contentType: 'application/json',
        }),
        idContext(id),
      );
    const responses = await Promise.all([rename('d1.txt'), rename('d2.txt')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);

    const present: string[] = [];
    for (const filePath of ['src.txt', 'd1.txt', 'd2.txt']) {
      const fileId = encodeFileId(filePath);
      const download = await downloadRoute(
        req('GET', `/api/files/${fileId}`, { workspace: WORKSPACE_A }),
        idContext(fileId),
      );
      if (download.status === 200) present.push(filePath);
    }
    // No duplicate: exactly one destination holds the bytes.
    expect(present).toHaveLength(1);
  });

  it('answers 413 to an oversized rename body before parsing it (FX-2)', async () => {
    const id = await uploadAndGetId(WORKSPACE_A, 'a.txt', 'x');
    const response = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ newPath: 'b.txt', padding: 'x'.repeat(1024 * 1024) }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(response.status).toBe(413);
  });

  it('refuses a rename body with an unknown field (FX-2)', async () => {
    const id = await uploadAndGetId(WORKSPACE_A, 'a.txt', 'x');
    const response = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ newPath: 'b.txt', extra: true }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(response.status).toBe(400);
  });
});

describe('the reserved .attachments/ prefix (ADR-0146 D6, issue #1308)', () => {
  const VISITOR_FILE = '.attachments/33333333-3333-4333-8333-333333333333/u1/scan.txt';

  const visitorCtx = {
    workspaceId: WORKSPACE_A,
    principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
    userId: null,
  };

  /** A visitor's upload is a catalog row like any other, saved by the surfaces through the service. */
  async function seedVisitorFile(): Promise<string> {
    const saved = await world.storage.save(visitorCtx, {
      area: 'files',
      path: VISITOR_FILE,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(new TextEncoder().encode('visitor')),
    });
    if (!saved.ok) throw new Error(`the visitor file was refused: ${saved.code}`);
    return encodeFileId(VISITOR_FILE);
  }

  const code = async (response: Response): Promise<string> =>
    ((await response.json()) as { error: { code: string } }).error.code;

  it('refuses a member writing into it: upload, folder and rename destination', async () => {
    const upload = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new Uint8Array([1]),
        headers: { 'x-file-path': '.attachments/x/y.txt' },
      }),
    );
    expect(upload.status).toBe(400);
    expect(await code(upload)).toBe('reserved_path');

    const folder = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        headers: { 'x-folder-path': '.attachments/x' },
      }),
    );
    expect(folder.status).toBe(400);
    expect(await code(folder)).toBe('reserved_path');

    const plain = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new Uint8Array([1]),
        headers: { 'x-file-path': 'plain.txt' },
      }),
    );
    expect(plain.status).toBe(201);
    const plainId = encodeFileId('plain.txt');
    const rename = await renameRoute(
      req('PATCH', `/api/files/${plainId}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ newPath: '.attachments/x/plain.txt' }),
        contentType: 'application/json',
      }),
      idContext(plainId),
    );
    expect(rename.status).toBe(400);
    expect(await code(rename)).toBe('reserved_path');
  });

  it('conceals it from a member: download, list and the folder at the root', async () => {
    const id = await seedVisitorFile();
    const download = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(download.status).toBe(404);
    expect(await code(download)).toBe('file_not_found');

    const inside = await listRoute(
      req('GET', '/api/files?path=.attachments', { workspace: WORKSPACE_A }),
    );
    expect(inside.status).toBe(404);

    const root = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(((await root.json()) as { files: unknown[] }).files).toEqual([]);
  });

  it('refuses a member deleting a visitor file or its folder, which stay stored', async () => {
    const id = await seedVisitorFile();
    for (const path of [
      VISITOR_FILE,
      '.attachments/33333333-3333-4333-8333-333333333333',
      '.Attachments',
    ]) {
      const target = encodeFileId(path);
      const refused = await deleteRoute(
        req('DELETE', `/api/files/${target}?recursive=true`, { workspace: WORKSPACE_A }),
        idContext(target),
      );
      expect(refused.status, path).toBe(400);
      expect(await code(refused)).toBe('reserved_path');
    }
    expect(await world.storage.get(visitorCtx, 'files', VISITOR_FILE)).not.toBeNull();
    expect(id).toBe(encodeFileId(VISITOR_FILE));
  });

  it('lets a member promote a visitor file by renaming it out, after which it is readable', async () => {
    const id = await seedVisitorFile();
    const rename = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ newPath: 'kept/scan.txt' }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(rename.status, await rename.clone().text()).toBe(200);
    expect(await rename.json()).toMatchObject({ file: { path: 'kept/scan.txt' } });
    const keptId = encodeFileId('kept/scan.txt');
    const download = await downloadRoute(
      req('GET', `/api/files/${keptId}`, { workspace: WORKSPACE_A }),
      idContext(keptId),
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('visitor');
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

  it('F4: an uploaded script is not served back as active content from this origin', async () => {
    const payload = '<script>alert(document.domain)</script>';
    // The uploader declares HTML; the download still answers with a type from the closed table.
    expect((await post('pwn.html', payload, 'text/html')).status).toBe(201);

    const id = encodeFileId('pwn.html');
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
      `attachment; filename="pwn.html"; filename*=UTF-8''pwn.html`,
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
 * Verification round 2, finding 1: `ownershipOfPath` (`apps/web/server/files/ownership.ts`)
 * compares a file's catalog `created_by` against the caller, but every test above runs as an
 * Owner, whose grant on `files` is `any` (`permissions.ts`) — wide enough that `decide()` never
 * even looks at what `ownershipOfPath` answered. This suite drives the same three routes as a
 * Builder, whose grant is `own`, so the comparison is the thing standing between the two Builders
 * below.
 *
 * The comparison reads a real `ResourceCatalogRepository` (`created_by` is tenant-paired to
 * `memberships` by a composite foreign key — see `packages/core/src/db/schema/files.ts`), and
 * the in-memory catalog has no such foreign key, so only PostgreSQL can show the pairing
 * hold. So this suite needs a real `TEST_DATABASE_URL` and skips loudly, rather than being
 * marked `.skip`, when one is not set —
 * the same `describe.skipIf` shape `resource-catalogs.test.ts` and `postgres-directory.test.ts`
 * use, so CI's real PostgreSQL 17 is the authority on whether it ran.
 */
describe.skipIf(!hasDatabase)(
  'own/other ownership on GET/DELETE/PATCH /api/files/:id (issue #117, PostgreSQL-backed)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
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

    beforeEach(() => {
      installTestDomains({
        files: {
          kind: 'serving',
          runtime: createCatalogFilesWorld({
            scopes: createInMemoryWorkspaceScopeResolver(
              [workspace.id].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
            ),
            resolveWorkspace: resolveWorkspaceFromHeader,
            catalogs: createResourceCatalogStoreProvider({
              repositories: root.resourceCatalogs,
              scopes: root.scopes,
            }),
          }).runtime,
        },
      });
      installTestDomains({
        rbac: {
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
        },
      });
    });

    afterEach(() => {
      clearApplicationContext();
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

describe('GET /api/files with a catalog (F-05: a GET never writes)', () => {
  it('answers catalogued rows by their catalog id and makes no catalog write', async () => {
    const catalog = createInMemoryCatalogStore();
    const rows = catalog.forWorkspaceSync(WORKSPACE_A);
    const docs = await seedCatalogFile(rows, {
      path: 'docs',
      kind: 'folder',
      sizeBytes: 0,
      contentType: null,
      ownerPrincipalId: 'owner-1',
    });
    const a = await seedCatalogFile(rows, {
      path: 'a.txt',
      kind: 'file',
      sizeBytes: 2,
      contentType: 'text/plain',
      ownerPrincipalId: 'owner-1',
    });
    const fixture = createCatalogFilesWorld({
      scopes: createInMemoryWorkspaceScopeResolver(
        [WORKSPACE_A].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
      ),
      resolveWorkspace: fixedWorkspaceA,
      catalogs: catalog,
    });
    // No catalog row: written outside the catalogued paths (or before the catalog existed). The
    // listing reads the catalog only, so it does not appear.
    await fixture.legacy
      .forWorkspace(WORKSPACE_A)
      .write('legacy.txt', new TextEncoder().encode('old'), {});
    installTestDomains({ files: { kind: 'serving', runtime: fixture.runtime } });

    const response = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      files: Array<{ id: string; path: string; kind: string; sizeBytes: number | null }>;
    };
    expect(
      body.files.map(({ id, path: filePath, kind, sizeBytes }) => ({
        id,
        path: filePath,
        kind,
        sizeBytes,
      })),
    ).toEqual([
      { id: a.id, path: 'a.txt', kind: 'file', sizeBytes: 2 },
      { id: docs.id, path: 'docs', kind: 'folder', sizeBytes: null },
    ]);
  });
});

/**
 * FX-1: the same own/other gate as the PostgreSQL suite above, on the shared in-memory catalog, for
 * the two writes that suite does not cover — the relay upload (`POST /api/files`) over another
 * member's file, and a recursive delete of an owned folder holding an object with no catalog row
 * (what a signed upload leaves until the next list). Both must answer a plain 403.
 */
describe('Builder own/other on the relay upload and on row-less objects (FX-1)', () => {
  const builderA = 'builder-a@example.test';
  const principalIds = new Map([
    [builderA, crypto.randomUUID()],
    ['builder-b@example.test', crypto.randomUUID()],
  ]);
  let catalogs: ReturnType<typeof createInMemoryCatalogStore>;

  beforeEach(() => {
    catalogs = createInMemoryCatalogStore();
    world = createCatalogFilesWorld({
      catalogs,
      scopes: createInMemoryWorkspaceScopeResolver(
        [WORKSPACE_A].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
      ),
      resolveWorkspace: fixedWorkspaceA,
    });
    installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({
          users: [
            {
              email: 'owner-a@example.test',
              name: 'Owner A',
              workspaceId: WORKSPACE_A,
              role: 'owner',
            },
          ],
        }),
        identify(request: Request) {
          const actor = request.headers.get(ACTOR_HEADER) ?? '';
          const principalId = principalIds.get(actor);
          return Promise.resolve(
            principalId === undefined
              ? null
              : Principal.fromApiKey({
                  principalId,
                  apiKeyId: principalId,
                  workspaceId: WORKSPACE_A,
                  role: 'builder',
                  label: actor,
                }),
          );
        },
      },
    });
  });

  function upload(actor: string, filePath: string, text: string): Promise<Response> {
    return uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode(text),
        contentType: 'text/plain',
        headers: { 'x-file-path': filePath, [ACTOR_HEADER]: actor },
      }),
    );
  }

  async function download(filePath: string): Promise<string> {
    const id = encodeFileId(filePath);
    const response = await downloadRoute(
      req('GET', `/api/files/${id}`, {
        workspace: WORKSPACE_A,
        headers: { [ACTOR_HEADER]: builderA },
      }),
      idContext(id),
    );
    expect(response.status).toBe(200);
    return response.text();
  }

  it("a Builder cannot overwrite another Builder's file through POST /api/files", async () => {
    expect((await upload(builderA, 'shared.txt', 'A bytes')).status).toBe(201);

    const overwrite = await upload('builder-b@example.test', 'shared.txt', 'B bytes');

    expect(overwrite.status).toBe(403);
    expect(await download('shared.txt')).toBe('A bytes');
    // The owner may still overwrite its own file.
    expect((await upload(builderA, 'shared.txt', 'A again')).status).toBe(201);
  });

  /** Save `text` at `path` as `actor` through the service, as a concurrent request would. */
  async function saveAs(actor: string, path: string, text: string): Promise<void> {
    const principalId = principalIds.get(actor) ?? '';
    const saved = await world.storage.save(
      { workspaceId: WORKSPACE_A, principalId, userId: null },
      {
        area: 'files',
        path,
        body: bytesToStream(new TextEncoder().encode(text)),
        maxBytes: 1024,
        replace: true,
      },
    );
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
  }

  /** Run `around` around the next reserve of `path`, the step after the route's ownership check. */
  function aroundReserve(path: string, around: (reserve: () => Promise<unknown>) => Promise<void>) {
    const repository = catalogs.forWorkspaceSync(WORKSPACE_A);
    const reserve = repository.reserve.bind(repository);
    repository.reserve = async (reserved, input) => {
      if (reserved !== path) return reserve(reserved, input);
      repository.reserve = reserve;
      let outcome: Awaited<ReturnType<typeof reserve>> | undefined;
      await around(async () => (outcome = await reserve(reserved, input)));
      if (outcome === undefined) throw new Error('the reserve did not run');
      return outcome;
    };
    return repository;
  }

  it('a Builder cannot replace a file another Builder creates after the ownership check', async () => {
    aroundReserve('race.txt', async (reserve) => {
      await saveAs('builder-b@example.test', 'race.txt', 'B bytes');
      await reserve();
    });

    const overwrite = await upload(builderA, 'race.txt', 'A bytes');

    expect(overwrite.status).toBe(403);
    expect(await download('race.txt')).toBe('B bytes');
  });
});

describe('routes answer existence and metadata questions without reading object bytes (FX-3)', () => {
  let getCalls: string[];

  beforeEach(() => {
    getCalls = [];
    const inner = createInMemoryObjectStore();
    world = createCatalogFilesWorld({
      catalogs: createInMemoryCatalogStore(),
      scopes: createInMemoryWorkspaceScopeResolver(
        [WORKSPACE_A].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
      ),
      resolveWorkspace: fixedWorkspaceA,
      objects: {
        ...inner,
        read(key, options) {
          getCalls.push(key);
          return inner.read(key, options);
        },
      },
    });
    installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  });

  async function upload(filePath: string, text: string): Promise<Response> {
    return uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode(text),
        contentType: 'text/plain',
        headers: { 'x-file-path': filePath },
      }),
    );
  }

  function rename(fromPath: string, newPath: string): Promise<Response> {
    const id = encodeFileId(fromPath);
    return renameRoute(
      req('PATCH', `/api/files/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ newPath }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
  }

  it('an upload answers its size and type without reading the object back', async () => {
    const response = await upload('a.txt', 'hello');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { file: { sizeBytes: number; contentType: string } };
    expect(body.file).toMatchObject({ sizeBytes: 5, contentType: 'text/plain' });
    expect(getCalls).toEqual([]);
  });

  it('DELETE of a file reads no object bytes', async () => {
    expect((await upload('a.txt', 'hello')).status).toBe(201);
    getCalls = [];
    const id = encodeFileId('a.txt');
    const response = await deleteRoute(
      req('DELETE', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(response.status).toBe(204);
    expect(getCalls).toEqual([]);
  });

  it('PATCH of a file reads no object bytes and keeps them intact', async () => {
    expect((await upload('a.txt', 'hello')).status).toBe(201);
    getCalls = [];
    const response = await rename('a.txt', 'b.txt');
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { file: { sizeBytes: number; contentType: string } };
    expect(body.file).toMatchObject({ sizeBytes: 5, contentType: 'text/plain' });
    expect(getCalls).toEqual([]);
    const id = encodeFileId('b.txt');
    const download = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(await download.text()).toBe('hello');
  });

  it('a folder move onto an existing destination is refused without reading bytes, and overwrites nothing', async () => {
    expect((await upload('src/a.txt', 'AAAA')).status).toBe(201);
    expect((await upload('src/b.txt', 'two')).status).toBe(201);
    expect((await upload('dst/a.txt', 'BBBB')).status).toBe(201);
    getCalls = [];
    const refused = await rename('src', 'dst');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'name_conflict' } });
    expect(getCalls).toEqual([]);

    const id = encodeFileId('dst/a.txt');
    const kept = await downloadRoute(
      req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(await kept.text()).toBe('BBBB');
  });
});

describe('a refused folder delete through DELETE /api/files/:id', () => {
  it('answers 409 folder_not_empty without ?recursive and keeps the rows', async () => {
    const catalogs = createInMemoryCatalogStore();
    world = createCatalogFilesWorld({
      scopes: createInMemoryWorkspaceScopeResolver(
        [WORKSPACE_A].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
      ),
      resolveWorkspace: fixedWorkspaceA,
      catalogs,
    });
    installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
    const uploaded = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode('x'),
        contentType: 'text/plain',
        headers: { 'x-file-path': 'team/a.txt' },
      }),
    );
    expect(uploaded.status).toBe(201);
    const before = await listCatalogFiles(catalogs.forWorkspaceSync(WORKSPACE_A));
    const id = encodeFileId('team');

    const response = await deleteRoute(
      req('DELETE', `/api/files/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'folder_not_empty' } });
    expect(await listCatalogFiles(catalogs.forWorkspaceSync(WORKSPACE_A))).toEqual(before);
  });
});

/**
 * FX-7: a pending catalog row is an upload in flight. Every route that would write over it, move
 * it, or move a folder holding it answers `409 upload_in_progress` and leaves bytes and rows as
 * they were.
 */
describe('an upload in flight answers 409 upload_in_progress (FX-7)', () => {
  let catalogs: ReturnType<typeof createInMemoryCatalogStore>;

  beforeEach(async () => {
    catalogs = createInMemoryCatalogStore();
    world = createCatalogFilesWorld({
      scopes: createInMemoryWorkspaceScopeResolver(
        [WORKSPACE_A].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
      ),
      resolveWorkspace: fixedWorkspaceA,
      catalogs,
    });
    installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
    await catalogs.forWorkspaceSync(WORKSPACE_A).reserve('docs/pending.txt', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
      sizeBytes: 3,
      contentType: 'text/plain',
    });
  });

  function upload(filePath: string, text: string): Promise<Response> {
    return uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode(text),
        contentType: 'text/plain',
        headers: { 'x-file-path': filePath },
      }),
    );
  }

  function move(from: string, newPath: string): Promise<Response> {
    const id = encodeFileId(from);
    return renameRoute(
      req('PATCH', `/api/files/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ newPath }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
  }

  async function download(filePath: string): Promise<Response> {
    const id = encodeFileId(filePath);
    return downloadRoute(req('GET', `/api/files/${id}`, { workspace: WORKSPACE_A }), idContext(id));
  }

  async function expectUploadInProgress(response: Response): Promise<void> {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
  }

  async function pendingRow(): Promise<unknown> {
    return catalogs.forWorkspaceSync(WORKSPACE_A).get('docs/pending.txt', { includePending: true });
  }

  it('refuses a relay upload over the pending path and writes no bytes', async () => {
    await expectUploadInProgress(await upload('docs/pending.txt', 'new'));
    expect((await download('docs/pending.txt')).status).toBe(404);
    expect(await pendingRow()).toMatchObject({ status: 'pending' });
  });

  it('refuses a folder created at the pending path and leaves no marker', async () => {
    const response = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        headers: { 'x-folder-path': 'docs/pending.txt' },
      }),
    );
    await expectUploadInProgress(response);
    expect(await pendingRow()).toMatchObject({ status: 'pending', kind: 'file' });
  });

  it('refuses a rename onto the pending path and keeps the source', async () => {
    expect((await upload('other.txt', 'abc')).status).toBe(201);
    await expectUploadInProgress(await move('other.txt', 'docs/pending.txt'));
    expect(await (await download('other.txt')).text()).toBe('abc');
    expect(await pendingRow()).toMatchObject({ status: 'pending' });
  });

  it('refuses a folder move while an upload under it is pending and copies nothing', async () => {
    expect((await upload('docs/ready.txt', 'abc')).status).toBe(201);
    await expectUploadInProgress(await move('docs', 'moved'));
    expect(await (await download('docs/ready.txt')).text()).toBe('abc');
    expect((await download('moved/ready.txt')).status).toBe(404);
    const rows = await listCatalogFiles(catalogs.forWorkspaceSync(WORKSPACE_A));
    expect(rows.map((row) => row.path)).toEqual(['docs', 'docs/ready.txt']);
  });
});

/**
 * #1991 C1: a write that replaces a file is authorized against the ready file its reserve locked,
 * not against the path the route checked earlier. Between the route's ownership read and the
 * reserve, another Builder can create the path; between the reserve and the decision, that file can
 * be renamed away (its pending replacement follows it) and the path reused. The gates below hold
 * one Builder's request at those two points, on the in-memory catalog and on PostgreSQL.
 */
interface ReplacementMember {
  readonly email: string;
  readonly principalId: string;
  readonly userId: string;
}

interface ReplacementWorld {
  readonly workspaceId: string;
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: Parameters<typeof createCatalogFilesWorld>[0]['scopes'];
  readonly builderA: ReplacementMember;
  readonly builderB: ReplacementMember;
  readonly admin: ReplacementMember;
}

type ReplacementRole = 'builderA' | 'builderB' | 'admin';

const memberOf = (label: string): ReplacementMember => ({
  email: `${label}@example.test`,
  principalId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
});

/** Holds a member's next `reserve` just before or just after it runs, until `release()`. */
function gatedReserves(inner: ResourceCatalogStoreProvider) {
  interface Gate {
    readonly stage: 'before' | 'after';
    readonly ownerPrincipalId: string;
    readonly entered: () => void;
    readonly released: Promise<void>;
  }
  const gates: Gate[] = [];
  const hold = async (stage: Gate['stage'], ownerPrincipalId: string): Promise<void> => {
    const index = gates.findIndex(
      (gate) => gate.stage === stage && gate.ownerPrincipalId === ownerPrincipalId,
    );
    const [gate] = index === -1 ? [] : gates.splice(index, 1);
    if (gate === undefined) return;
    gate.entered();
    await gate.released;
  };
  const catalogs: ResourceCatalogStoreProvider = {
    async forWorkspace(workspaceId) {
      const catalog = await inner.forWorkspace(workspaceId);
      return {
        ...catalog,
        async reserve(path, input) {
          await hold('before', input.ownerPrincipalId);
          const reserved = await catalog.reserve(path, input);
          await hold('after', input.ownerPrincipalId);
          return reserved;
        },
      };
    },
  };
  const arm = (stage: Gate['stage'], member: ReplacementMember) => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    gates.push({ stage, ownerPrincipalId: member.principalId, entered, released });
    return { reached, release };
  };
  return { catalogs, arm };
}

/** An in-memory object store that signs, so the signed-upload route reaches its reserve. */
function signingStore() {
  const inner = createInMemoryObjectStore();
  return {
    ...inner,
    capabilities: { ...inner.capabilities, sign: true, boundLengthSign: true },
    createSignedUrl: (key: string) =>
      Promise.resolve({ url: `https://store.invalid/${key}`, headers: {} }),
  };
}

function memoryReplacementWorld(): Promise<ReplacementWorld> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'replace-memory' }]),
    builderA: memberOf('replace-builder-a'),
    builderB: memberOf('replace-builder-b'),
    admin: memberOf('replace-admin'),
  });
}

let replacementDatabase: IsolatedTestDatabase | undefined;

async function postgresReplacementWorld(): Promise<ReplacementWorld> {
  if (replacementDatabase === undefined) throw new Error('the test database did not start');
  const db = replacementDatabase.db;
  const workspaceId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `replace-${workspaceId}`, name: 'Replace' });
  const member = async (label: string, role: 'builder' | 'admin') => {
    const seeded = memberOf(label);
    const membershipId = crypto.randomUUID();
    await db.insert(users).values({ id: seeded.userId, email: seeded.email, name: label });
    await db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId: seeded.userId, role });
      await tx
        .insert(workspacePrincipals)
        .values({ id: seeded.principalId, workspaceId, kind: 'membership', membershipId });
    });
    return seeded;
  };
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return {
    workspaceId,
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes,
    }),
    scopes,
    builderA: await member(`replace-a-${workspaceId}`, 'builder'),
    builderB: await member(`replace-b-${workspaceId}`, 'builder'),
    admin: await member(`replace-admin-${workspaceId}`, 'admin'),
  };
}

function defineReplacementSuite(name: string, setup: () => Promise<ReplacementWorld>) {
  describe(`a replacement is authorized against the file its reserve locked, on the ${name} (#1991 C1)`, () => {
    let replacement: ReplacementWorld;
    let gates: ReturnType<typeof gatedReserves>;

    beforeEach(async () => {
      replacement = await setup();
      gates = gatedReserves(replacement.catalogs);
      const roles = new Map<string, { member: ReplacementMember; role: 'builder' | 'admin' }>([
        [replacement.builderA.email, { member: replacement.builderA, role: 'builder' }],
        [replacement.builderB.email, { member: replacement.builderB, role: 'builder' }],
        [replacement.admin.email, { member: replacement.admin, role: 'admin' }],
      ]);
      const { workspaceId } = replacement;
      const files = createCatalogFilesWorld({
        catalogs: gates.catalogs,
        scopes: replacement.scopes,
        objects: signingStore(),
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId }),
      });
      installTestDomains({ files: { kind: 'serving', runtime: files.runtime } });
      installTestDomains({
        rbac: {
          directory: createMemoryDirectory({ users: [] }),
          identify(request: Request) {
            const known = roles.get(request.headers.get(ACTOR_HEADER) ?? '');
            return Promise.resolve(
              known === undefined
                ? null
                : Principal.fromUserToken(workspaceId, known.member.email, known.role, {
                    principalId: known.member.principalId,
                    userId: known.member.userId,
                    label: known.member.email,
                  }),
            );
          },
        },
      });
    });

    const actor = (role: ReplacementRole): ReplacementMember => replacement[role];

    function upload(role: ReplacementRole, filePath: string, text: string): Promise<Response> {
      return uploadRoute(
        req('POST', '/api/files', {
          body: new TextEncoder().encode(text),
          contentType: 'text/plain',
          headers: { 'x-file-path': filePath, [ACTOR_HEADER]: actor(role).email },
        }),
      );
    }

    function mintUpload(role: ReplacementRole, filePath: string): Promise<Response> {
      const id = encodeFileId(filePath);
      return uploadUrlRoute(
        req('POST', `/api/files/${id}/upload-urls`, {
          body: JSON.stringify({ sizeBytes: 4 }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: actor(role).email },
        }),
        idContext(id),
      );
    }

    async function contentOf(filePath: string): Promise<string> {
      const id = encodeFileId(filePath);
      const response = await downloadRoute(
        req('GET', `/api/files/${id}`, { headers: { [ACTOR_HEADER]: actor('admin').email } }),
        idContext(id),
      );
      expect(response.status, filePath).toBe(200);
      return response.text();
    }

    const catalog = () => replacement.catalogs.forWorkspace(replacement.workspaceId);

    async function expectForbidden(response: Response): Promise<void> {
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    }

    it('a Builder cannot replace a file another Builder creates after the ownership check', async () => {
      const beforeReserve = gates.arm('before', actor('builderA'));
      const late = upload('builderA', 'race.txt', 'A bytes');
      await beforeReserve.reached;

      expect((await upload('builderB', 'race.txt', 'B bytes')).status).toBe(201);
      beforeReserve.release();

      await expectForbidden(await late);
      expect(await contentOf('race.txt')).toBe('B bytes');
      await expect((await catalog()).get('race.txt')).resolves.toMatchObject({
        ownerPrincipalId: actor('builderB').principalId,
        status: 'ready',
      });
      await expect((await catalog()).countPending()).resolves.toBe(0);
    });

    it('an owner still replaces its own file, by relay and by a signed link', async () => {
      expect((await upload('builderA', 'own.txt', 'first')).status).toBe(201);
      expect((await upload('builderA', 'own.txt', 'second')).status).toBe(201);
      expect(await contentOf('own.txt')).toBe('second');
      expect((await mintUpload('builderA', 'own.txt')).status).toBe(201);
    });

    it("an Admin still replaces any member's file", async () => {
      expect((await upload('builderB', 'theirs.txt', 'B bytes')).status).toBe(201);
      expect((await upload('admin', 'theirs.txt', 'Admin bytes')).status).toBe(201);
      expect(await contentOf('theirs.txt')).toBe('Admin bytes');
      expect((await mintUpload('admin', 'theirs.txt')).status).toBe(201);
    });
  });
}

defineReplacementSuite('in-memory catalog', memoryReplacementWorld);

describe('on PostgreSQL', () => {
  beforeAll(async () => {
    replacementDatabase = await createIsolatedTestDatabase('aw_files_replace');
  }, 180_000);

  afterAll(async () => replacementDatabase?.close());

  defineReplacementSuite('PostgreSQL catalog', postgresReplacementWorld);
});
