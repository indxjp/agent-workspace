/**
 * Minting a signed upload link reserves a pending catalog row (the storage design, §04): the file
 * is not listed, searched or granted until the upload is completed, and `upload-complete` checks
 * the object and makes it so (§04, §05). Driven with real `Request` objects against the catalog
 * service over an in-memory catalog and object store; writing to the object named by the pending
 * row stands in for the browser's `PUT`.
 */
// @story US-STO-02
import { createHash } from 'node:crypto';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute } from '../../app/api/files/route';
import { GET as searchRoute } from '../../app/api/files/search/route';
import { GET as downloadRoute, PATCH as renameRoute } from '../../app/api/files/[id]/route';
import { POST as downloadUrlRoute } from '../../app/api/files/[id]/download-urls/route';
import { POST as completeRoute } from '../../app/api/files/[id]/upload-complete/route';
import { POST as uploadUrlRoute } from '../../app/api/files/[id]/upload-urls/route';
import {
  bytesToStream,
  createInMemoryObjectStore,
  SignedUrlUnsupportedError,
  storageObjectName,
  type ObjectStore,
  type SignedUrlRequest,
} from '@agent-workspace/core/storage';
import type { FileTextRepository } from '@agent-workspace/core/db';
import {
  LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE,
  MAX_PENDING_UPLOADS_PER_WORKSPACE,
} from '@indx-workspace/contracts/files';

import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { encodeFileId } from './file-id';
import { refuseLinkRequest, resetLinkRequestLimits } from './uploads';
import { createCatalogFilesWorld } from './catalog-runtime-fixtures';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { createAgentRunResourceLoader } from '../compose/resource-loader';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { StorageService } from '../storage/service';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ACTOR_HEADER = 'x-test-actor';
const ME = '37d41bbb-42d1-4a16-8f5d-de3fef42eed0';
const SOMEONE_ELSE = '5b0f6b44-6b7e-4a52-9f5e-6c0e3c1d2a77';
const ctx = { workspaceId: WORKSPACE, principalId: ME, userId: null };

type Actor = 'owner' | 'admin' | 'builder' | 'viewer';

function principalFor(actor: Actor): Principal {
  return Principal.fromApiKey({
    principalId: actor === 'builder' ? SOMEONE_ELSE : ME,
    apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: WORKSPACE,
    role: actor,
    label: 'Upload reservation test key',
  });
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * The root store, signing every key as a link on the storage domain. `bindsLength: false` behaves
 * like Azure Blob, whose SAS cannot carry an upload length. Every sign request is appended to
 * `requests`.
 */
function signingRoot(bindsLength = true, requests: SignedUrlRequest[] = []): ObjectStore {
  const store = createInMemoryObjectStore();
  return {
    ...store,
    capabilities: { ...store.capabilities, sign: true, boundLengthSign: bindsLength },
    createSignedUrl: (key, request) => {
      requests.push(request);
      return !bindsLength && request.requireBoundContentLength === true
        ? Promise.reject(new SignedUrlUnsupportedError('no length binding'))
        : Promise.resolve({ url: `https://store.invalid/${key}`, headers: {} });
    },
  };
}

let catalog: ReturnType<typeof createInMemoryCatalogStore>;
let root: ObjectStore;
let storage: StorageService;
let cachedTerms: Map<string, string>;

/** The text cache as far as the search route goes: terms per file id, filtered by the allow-list. */
function textCache(): FileTextRepository {
  return {
    listStale: async () =>
      (await catalog.forWorkspaceSync(WORKSPACE).listFiles())
        .filter((row) => row.kind === 'file' && !cachedTerms.has(row.id))
        .map((row) => ({
          id: row.id,
          path: row.path,
          storageKey: row.storageKey ?? row.path,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          updatedAt: '',
        })),
    replace: (fileId, _source, passages) => {
      cachedTerms.set(fileId, passages.map((passage) => passage.terms).join(' '));
      return Promise.resolve(true);
    },
    search: async (tsquery, _limit, allowedFileIds) => {
      const word = tsquery.replaceAll("'", '');
      const rows = await catalog.forWorkspaceSync(WORKSPACE).listFiles();
      return rows.flatMap((row) =>
        (allowedFileIds === null || allowedFileIds.includes(row.id)) &&
        cachedTerms.get(row.id)?.split(' ').includes(word) === true
          ? [{ fileId: row.id, path: row.path, page: null, text: word, score: 1 }]
          : [],
      );
    },
  };
}

/** Install the files runtime; a deployment limit below the hard maximum is `signedUploadMaxBytes`. */
function installFiles(signedUploadMaxBytes?: number): void {
  const world = createCatalogFilesWorld({
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    catalogs: catalog,
    objects: root,
  });
  storage = world.storage;
  installTestDomains({
    files: {
      kind: 'serving',
      runtime: {
        ...world.runtime,
        texts: { forWorkspace: () => Promise.resolve(textCache()) },
        ...(signedUploadMaxBytes === undefined ? {} : { signedUploadMaxBytes }),
      },
    },
    rbac: {
      directory: createMemoryDirectory({
        users: [
          { email: 'owner@example.test', name: 'Owner', workspaceId: WORKSPACE, role: 'owner' },
        ],
      }),
      identify: (request: Request) =>
        Promise.resolve(principalFor((request.headers.get(ACTOR_HEADER) ?? 'owner') as Actor)),
    },
  });
}

beforeEach(() => {
  resetLinkRequestLimits();
  cachedTerms = new Map();
  catalog = createInMemoryCatalogStore();
  root = signingRoot();
  installFiles();
});

afterEach(() => {
  clearApplicationContext();
});

const mint = (filePath: string, actor: Actor = 'owner', sizeBytes = 5): Promise<Response> =>
  uploadUrlRoute(
    new Request(`https://example.invalid/api/files/${encodeFileId(filePath)}/upload-urls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTOR_HEADER]: actor },
      body: JSON.stringify({ sizeBytes }),
    }),
    { params: Promise.resolve({ id: encodeFileId(filePath) }) },
  );

const complete = (filePath: string, actor: Actor = 'owner'): Promise<Response> =>
  completeRoute(
    new Request(`https://example.invalid/api/files/${encodeFileId(filePath)}/upload-complete`, {
      method: 'POST',
      headers: { [ACTOR_HEADER]: actor },
    }),
    { params: Promise.resolve({ id: encodeFileId(filePath) }) },
  );

const search = (q: string) =>
  searchRoute(
    new Request(`https://example.invalid/api/files/search?q=${q}`, {
      headers: { [ACTOR_HEADER]: 'owner' },
    }),
  );

async function listedPaths(under?: string): Promise<string[]> {
  const response = await listRoute(
    new Request(`https://example.invalid/api/files${under === undefined ? '' : `?path=${under}`}`, {
      headers: { [ACTOR_HEADER]: 'owner' },
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { files: Array<{ path: string }> }).files.map((f) => f.path);
}

/** A file saved straight through the service: ready, with its own object. */
async function save(path: string, text: string) {
  const saved = await storage.save(ctx, {
    area: 'files',
    path,
    body: bytesToStream(bytesOf(text)),
    maxBytes: 1024,
    replace: true,
  });
  if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
  return saved.row;
}

/**
 * The `PUT` to the signed URL, as far as the store is concerned: the bytes land in the object the
 * pending row names. Returns that object's key.
 */
async function putPending(
  filePath: string,
  body: Uint8Array = bytesOf('hello'),
  contentType = 'text/plain',
): Promise<string> {
  const objectId = (await catalog.forWorkspaceSync(WORKSPACE).pending(filePath))?.objectId;
  if (objectId === undefined || objectId === null) throw new Error(`${filePath} has no upload`);
  const key = storageObjectName(WORKSPACE, 'files', objectId);
  await root.write(key, body, { contentType });
  return key;
}

const pendingRow = () =>
  catalog.forWorkspaceSync(WORKSPACE).get('docs/a.txt', { includePending: true });

async function read(path: string): Promise<string> {
  const response = await downloadRoute(
    new Request(`https://example.invalid/api/files/${encodeFileId(path)}`, {
      headers: { [ACTOR_HEADER]: 'owner' },
    }),
    { params: Promise.resolve({ id: encodeFileId(path) }) },
  );
  expect(response.status).toBe(200);
  return response.text();
}

describe('POST /api/files/:id/upload-urls reserves a pending row', () => {
  // @story US-STO-02
  it('[US-STO-02][api][sdk] a 100 MiB signed upload is accepted when the deployment allows it', async () => {
    const size = 100 * 1024 * 1024;
    const response = await mint('docs/a.txt', 'owner', size);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await pendingRow()).toMatchObject({ status: 'pending', sizeBytes: size });
    await putPending('docs/a.txt', new Uint8Array(size));
    const done = await complete('docs/a.txt');
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await pendingRow()).toMatchObject({ status: 'ready', sizeBytes: size });
  });

  it('[US-STO-02][api][sdk] minting a link reserves a pending row that no list shows', async () => {
    const response = await mint('docs/a.txt');
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await pendingRow()).toMatchObject({
      path: 'docs/a.txt',
      status: 'pending',
      sizeBytes: 5,
      contentType: 'text/plain',
      ownerPrincipalId: ME,
    });
    await putPending('docs/a.txt');
    expect(await listedPaths()).not.toContain('docs/a.txt');
    const ready = await catalog.forWorkspaceSync(WORKSPACE).listFiles();
    expect(ready.map((row) => row.path)).not.toContain('docs/a.txt');
  });

  it('[US-STO-02][api][sdk] a mint over the deployment limit answers 413 and reserves nothing', async () => {
    installFiles(8);
    const response = await mint('docs/a.txt', 'owner', 9);
    expect(response.status).toBe(413);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'request_body_too_large' } });
    expect(text).not.toContain('store.invalid');
    expect(await pendingRow()).toBeNull();
    expect((await mint('docs/a.txt', 'owner', 8)).status).toBe(201);
  });

  it('[US-STO-02][api][sdk] a pending object is hidden from GET /api/files', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt');
    await save('docs/b.txt', 'b');
    expect(await listedPaths()).toEqual(['docs']);
    expect(await listedPaths('docs')).toEqual(['docs/b.txt']);
  });

  it('[US-STO-02][api][sdk] re-minting keeps one row', async () => {
    const first = await pendingRow();
    expect(first).toBeNull();
    expect((await mint('docs/a.txt')).status).toBe(201);
    const row = await pendingRow();
    expect((await mint('docs/a.txt')).status).toBe(201);
    // The same row, under a new reservation: a request holding the first link's snapshot is stale.
    // The re-mint is a write, so the row's write time moves too.
    const again = await pendingRow();
    const sameRow = { reservationToken: null, updatedAt: null };
    expect({ ...again, ...sameRow }).toEqual({ ...row, ...sameRow });
    expect(again?.reservationToken).not.toBe(row?.reservationToken);
  });

  it('[US-STO-02][api][sdk] a viewer cannot mint and no row appears', async () => {
    const response = await mint('docs/a.txt', 'viewer');
    expect(response.status).toBe(403);
    expect(await pendingRow()).toBeNull();
  });

  it('[US-STO-02][api][sdk] minting over a ready file stays ready', async () => {
    const row = await save('docs/a.txt', 'x');
    expect((await mint('docs/a.txt')).status).toBe(201);
    expect(await pendingRow()).toMatchObject({ id: row.id, status: 'ready' });
    expect(await read('docs/a.txt')).toBe('x');
  });

  it('[US-STO-02][api][sdk] a Builder gets no link over a file another member created after authorisation', async () => {
    const repository = catalog.forWorkspaceSync(WORKSPACE);
    const reserve = repository.reserve.bind(repository);
    let created: Awaited<ReturnType<typeof repository.putFile>> | null = null;
    // The path was absent when the route authorised; the owner creates it before the reservation.
    repository.reserve = async (path, input) => {
      created = await repository.putFile({
        path,
        kind: 'file',
        storageKey: path,
        sizeBytes: 1,
        contentType: 'text/plain',
        ownerPrincipalId: ME,
      });
      return reserve(path, input);
    };
    const response = await mint('docs/a.txt', 'builder');
    repository.reserve = reserve;
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('store.invalid');
    expect(await pendingRow()).toEqual(created);
  });

  it('[US-STO-02][api][sdk] a Builder gets no link over a reserved target that is renamed and its old path reused', async () => {
    const repository = catalog.forWorkspaceSync(WORKSPACE);
    const reserve = repository.reserve.bind(repository);
    const file = (path: string, ownerPrincipalId: string) => ({
      path,
      kind: 'file' as const,
      storageKey: path,
      sizeBytes: 1,
      contentType: 'text/plain',
      ownerPrincipalId,
    });
    // The owner creates the path after the route authorised; once the replacement is reserved, the
    // owner's file (and the replacement with it) moves away and the Builder writes its own file at
    // the old path. A decision that reads the path again would see the Builder's file.
    repository.reserve = async (path, input) => {
      await repository.putFile(file(path, ME));
      const outcome = await reserve(path, input);
      await repository.renameFile(path, { ...file('docs/moved.txt', ME), storageKey: path });
      await repository.putFile(file(path, SOMEONE_ELSE));
      return outcome;
    };
    const response = await mint('docs/a.txt', 'builder');
    repository.reserve = reserve;

    expect(response.status).toBe(403);
    await expect(repository.get('docs/moved.txt')).resolves.toMatchObject({ ownerPrincipalId: ME });
    await expect(repository.pending('docs/moved.txt')).resolves.toBeNull();
  });

  it('[US-STO-02][api][sdk] an Azure-style store signs a new path unbound, and the oversize object is deleted at completion', async () => {
    root = signingRoot(false);
    installFiles();
    const response = await mint('docs/a.txt', 'owner', 3);
    expect(response.status, await response.clone().text()).toBe(201);
    const key = await putPending('docs/a.txt');
    const done = await complete('docs/a.txt');
    expect(done.status).toBe(409);
    expect(await root.head(key)).toBeNull();
    expect(await pendingRow()).toBeNull();
  });

  it('[US-STO-02][api][sdk] a folder row answers 409 and returns no link', async () => {
    await catalog.forWorkspaceSync(WORKSPACE).putFile({
      path: 'docs',
      kind: 'folder',
      storageKey: null,
      sizeBytes: 0,
      contentType: null,
      ownerPrincipalId: ME,
    });
    const response = await mint('docs');
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('store.invalid');
  });

  it('[US-STO-02][api][sdk] a pending upload by another member answers 409 upload_in_progress', async () => {
    const reserved = await catalog.forWorkspaceSync(WORKSPACE).reserve('docs/a.txt', {
      ownerPrincipalId: '5b0c9a51-7f3e-4c1d-9a2b-3c4d5e6f7a8b',
      sizeBytes: 5,
      contentType: 'text/plain',
    });
    const response = await mint('docs/a.txt');
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain('upload_in_progress');
    expect(text).not.toContain('store.invalid');
    expect(await pendingRow()).toEqual(reserved.row);
  });

  it('[US-STO-02][api][sdk] a failing reserve answers a typed 500 and returns no link', async () => {
    const repository = catalog.forWorkspaceSync(WORKSPACE);
    const reserve = repository.reserve.bind(repository);
    repository.reserve = () => Promise.reject(new Error('connection to db.internal refused'));
    const response = await mint('docs/a.txt');
    repository.reserve = reserve;
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('catalog_unavailable');
    expect(text).not.toContain('store.invalid');
    expect(text).not.toContain('db.internal');
  });
});

describe('PATCH /api/files/:id on a pending row', () => {
  const rename = (from: string, newPath: string) =>
    renameRoute(
      new Request(`https://example.invalid/api/files/${encodeFileId(from)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', [ACTOR_HEADER]: 'owner' },
        body: JSON.stringify({ newPath }),
      }),
      { params: Promise.resolve({ id: encodeFileId(from) }) },
    );

  it('[US-STO-02][api][sdk] refuses a pending row and moves nothing', async () => {
    await mint('docs/a.txt');
    const key = await putPending('docs/a.txt');
    const response = await rename('docs/a.txt', 'docs/b.txt');
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('upload_in_progress');
    expect(await root.head(key)).not.toBeNull();
    expect(await pendingRow()).toMatchObject({ status: 'pending' });
    expect(
      await catalog.forWorkspaceSync(WORKSPACE).get('docs/b.txt', { includePending: true }),
    ).toBeNull();
  });

  it('[US-STO-02][api][sdk] refuses a rename onto a pending path and moves nothing', async () => {
    await mint('docs/b.txt');
    const reserved = await catalog
      .forWorkspaceSync(WORKSPACE)
      .get('docs/b.txt', { includePending: true });
    const ready = await save('docs/a.txt', 'hello');
    const response = await rename('docs/a.txt', 'docs/b.txt');
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('upload_in_progress');
    expect(await read('docs/a.txt')).toBe('hello');
    expect(await catalog.forWorkspaceSync(WORKSPACE).get('docs/a.txt')).toMatchObject({
      id: ready.id,
    });
    expect(
      await catalog.forWorkspaceSync(WORKSPACE).get('docs/b.txt', { includePending: true }),
    ).toEqual(reserved);
  });
});

describe('delivery of a pending row', () => {
  const fileUrl = `https://example.invalid/api/files/${encodeFileId('docs/a.txt')}`;
  const params = { params: Promise.resolve({ id: encodeFileId('docs/a.txt') }) };

  it('[US-STO-02][api][sdk] GET /api/files/:id answers 404 for a put but uncompleted upload', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt');
    const response = await downloadRoute(
      new Request(fileUrl, { headers: { [ACTOR_HEADER]: 'owner' } }),
      params,
    );
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('file_not_found');
    expect(text).not.toContain('hello');
  });

  it('[US-STO-02][api][sdk] POST /api/files/:id/download-urls answers 404 and signs nothing', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt');
    const response = await downloadUrlRoute(
      new Request(`${fileUrl}/download-urls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [ACTOR_HEADER]: 'owner' },
        body: JSON.stringify({}),
      }),
      params,
    );
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('file_not_found');
    expect(text).not.toContain('store.invalid');
    expect(text).not.toContain('ttl=');
  });
});

describe('POST /api/files/:id/upload-complete', () => {
  const fileUrl = `https://example.invalid/api/files/${encodeFileId('docs/a.txt')}`;
  const params = { params: Promise.resolve({ id: encodeFileId('docs/a.txt') }) };

  it('[US-STO-02][api][sdk] a signed-link upload can be searched and given to an agent', async () => {
    expect((await mint('docs/a.txt')).status).toBe(201);
    await putPending('docs/a.txt');
    expect(((await (await search('hello')).json()) as { hits: unknown[] }).hits).toEqual([]);

    const done = await complete('docs/a.txt');
    expect(done.status, await done.clone().text()).toBe(200);
    const found = (await (await search('hello')).json()) as { hits: Array<{ path: string }> };
    expect(found.hits.map((hit) => hit.path)).toEqual(['docs/a.txt']);

    const row = await catalog.forWorkspaceSync(WORKSPACE).get('docs/a.txt');
    if (row === null) throw new Error('the completed row must be ready');
    const loader = createAgentRunResourceLoader({ catalog, storage });
    const selection = await loader.load(WORKSPACE, {
      files: [{ fileId: row.id, access: 'read' }],
      skillIds: [],
      connectorIds: [],
    });
    expect(selection.files).toEqual([
      {
        kind: 'file',
        path: 'docs/a.txt',
        access: 'read',
        size: 5,
        sha256: createHash('sha256').update('hello').digest('hex'),
      },
    ]);
  });

  it('[US-STO-02][api][sdk] complete marks the row ready and the file is listed under its row id', async () => {
    await mint('docs/a.txt');
    const reserved = await pendingRow();
    await putPending('docs/a.txt');
    const response = await complete('docs/a.txt');
    expect(response.status, await response.clone().text()).toBe(200);
    // The row's id, the one list and grants use, not the path-derived id.
    expect(await response.json()).toMatchObject({
      file: { id: reserved?.id, path: 'docs/a.txt', kind: 'file', sizeBytes: 5 },
    });
    expect(await pendingRow()).toMatchObject({ id: reserved?.id, status: 'ready', sizeBytes: 5 });
    expect(await listedPaths()).toEqual(['docs']);
    const download = await downloadRoute(
      new Request(fileUrl, { headers: { [ACTOR_HEADER]: 'owner' } }),
      params,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('hello');
    const signed = await downloadUrlRoute(
      new Request(`${fileUrl}/download-urls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [ACTOR_HEADER]: 'owner' },
        body: JSON.stringify({}),
      }),
      params,
    );
    expect(signed.status).toBe(201);
  });

  it('[US-STO-02][api][sdk] complete deletes an oversize object', async () => {
    await mint('docs/a.txt', 'owner', 3);
    const key = await putPending('docs/a.txt');
    const response = await complete('docs/a.txt');
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('upload_not_verified');
    expect(await root.head(key)).toBeNull();
    expect(await pendingRow()).toBeNull();
  });

  it('[US-STO-02][api][sdk] complete deletes an object larger than declared', async () => {
    installFiles(8);
    await mint('docs/a.txt', 'owner', 8);
    const key = await putPending('docs/a.txt', new Uint8Array(9));
    const response = await complete('docs/a.txt');
    expect(response.status).toBe(409);
    expect(await root.head(key)).toBeNull();
    expect(await pendingRow()).toBeNull();
  });

  it('[US-STO-02][api][sdk] complete before the PUT keeps the row pending', async () => {
    await mint('docs/a.txt');
    const response = await complete('docs/a.txt');
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('upload_not_verified');
    expect(await pendingRow()).toMatchObject({ status: 'pending' });
  });

  it('[US-STO-02][api][sdk] complete keeps the row pending when the object is smaller than declared', async () => {
    await mint('docs/a.txt', 'owner', 9);
    const key = await putPending('docs/a.txt');
    const response = await complete('docs/a.txt');
    expect(response.status).toBe(409);
    expect(await pendingRow()).toMatchObject({ status: 'pending', sizeBytes: 9 });
    expect(await root.head(key)).not.toBeNull();
  });

  it('[US-STO-02][api][sdk] complete records the type from the file name', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt', bytesOf('hello'), 'application/x-evil');
    const response = await complete('docs/a.txt');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ file: { contentType: 'text/plain' } });
    expect(await pendingRow()).toMatchObject({ contentType: 'text/plain' });
  });

  it('[US-STO-02][api][sdk] complete answers 404 for a path nobody reserved', async () => {
    const response = await complete('docs/a.txt');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('file_not_found');
  });

  it('[US-STO-02][api][sdk] completing twice answers 200 both times with one row', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt');
    const first = await complete('docs/a.txt');
    const row = await pendingRow();
    const second = await complete('docs/a.txt');
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await pendingRow()).toEqual(row);
  });

  it('[US-STO-02][api][sdk] owner and admin complete, viewer and another builder are refused', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt');
    for (const actor of ['viewer', 'builder'] as const) {
      expect((await complete('docs/a.txt', actor)).status, actor).toBe(403);
      expect(await pendingRow(), actor).toMatchObject({ status: 'pending' });
    }
    expect((await complete('docs/a.txt', 'admin')).status).toBe(200);
    expect((await complete('docs/a.txt', 'owner')).status).toBe(200);
  });

  it('[US-STO-02][api][sdk] a failing confirm answers a typed 500 that leaks nothing', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt');
    const repository = catalog.forWorkspaceSync(WORKSPACE);
    const confirm = repository.confirm.bind(repository);
    repository.confirm = () => Promise.reject(new Error('connection to db.internal refused'));
    const response = await complete('docs/a.txt');
    repository.confirm = confirm;
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('catalog_unavailable');
    expect(text).not.toContain('db.internal');
    expect(await pendingRow()).toMatchObject({ status: 'pending' });
  });
});

describe('pending upload cap', () => {
  /** Pending rows written straight to the catalog, so they do not count as link requests. */
  async function seedPending(count: number): Promise<void> {
    const repository = catalog.forWorkspaceSync(WORKSPACE);
    for (let index = 0; index < count; index += 1) {
      await repository.reserve(`seed/${index}.bin`, {
        sizeBytes: 5,
        contentType: null,
        ownerPrincipalId: ME,
      });
    }
  }
  const pendingCount = () => catalog.forWorkspaceSync(WORKSPACE).countPending();

  it('[US-STO-02][api][sdk] the 101st unfinished upload is refused', async () => {
    await seedPending(MAX_PENDING_UPLOADS_PER_WORKSPACE);
    const response = await mint('docs/a.txt');
    expect(response.status).toBe(429);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'too_many_pending_uploads' } });
    expect(text).not.toContain('store.invalid');
    expect(await pendingRow()).toBeNull();
    expect(await pendingCount()).toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE);
  });

  it('[US-STO-02][api][sdk] completing an upload frees a slot', async () => {
    await seedPending(MAX_PENDING_UPLOADS_PER_WORKSPACE - 1);
    expect((await mint('docs/a.txt')).status).toBe(201);
    expect((await mint('docs/b.txt')).status).toBe(429);
    await putPending('docs/a.txt');
    expect((await complete('docs/a.txt')).status).toBe(200);
    expect(await pendingCount()).toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE - 1);
    expect((await mint('docs/b.txt')).status).toBe(201);
  });

  it('[US-STO-02][api][sdk] re-minting a pending path at the cap is not counted twice', async () => {
    await seedPending(MAX_PENDING_UPLOADS_PER_WORKSPACE - 1);
    expect((await mint('docs/a.txt')).status).toBe(201);
    expect((await mint('docs/a.txt')).status).toBe(201);
    expect(await pendingCount()).toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE);
  });

  it('[US-STO-02][api][sdk] minting over a ready file at the cap is refused and leaves the file and no extra row', async () => {
    // An overwrite reserves a pending row beside the ready file, so it counts against the cap.
    const ready = await save('docs/a.txt', 'x');
    await seedPending(MAX_PENDING_UPLOADS_PER_WORKSPACE);
    expect((await mint('docs/a.txt')).status).toBe(429);
    expect(await pendingRow()).toMatchObject({ id: ready.id, status: 'ready' });
    expect(await pendingCount()).toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE);
    expect(await read('docs/a.txt')).toBe('x');
  });

  it('[US-STO-02][api][sdk] a failing count answers a typed 500 and returns no link', async () => {
    const repository = catalog.forWorkspaceSync(WORKSPACE);
    const countPending = repository.countPending.bind(repository);
    repository.countPending = () => Promise.reject(new Error('connection to db.internal refused'));
    const response = await mint('docs/a.txt');
    repository.countPending = countPending;
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('catalog_unavailable');
    expect(text).not.toContain('store.invalid');
    expect(text).not.toContain('db.internal');
  });
});

describe('link request rate limit', () => {
  const download = (filePath: string): Promise<Response> =>
    downloadUrlRoute(
      new Request(`https://example.invalid/api/files/${encodeFileId(filePath)}/download-urls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [ACTOR_HEADER]: 'owner' },
        body: '{}',
      }),
      { params: Promise.resolve({ id: encodeFileId(filePath) }) },
    );

  it('[US-STO-02][api][sdk] link requests are rate limited', async () => {
    for (let index = 0; index < LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE; index += 1) {
      expect((await mint('docs/a.txt')).status, `request ${index + 1}`).toBe(201);
    }
    const response = await mint('docs/a.txt');
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'link_rate_limited' } });
    expect(text).not.toContain('store.invalid');
    const downloadResponse = await download('docs/a.txt');
    expect(downloadResponse.status).toBe(429);
    expect(downloadResponse.headers.get('retry-after')).not.toBeNull();
    expect(await downloadResponse.text()).toContain('link_rate_limited');
  });

  it('[US-STO-02][api][sdk] a refused caller does not use up the workspace allowance', async () => {
    for (let index = 0; index < LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE; index += 1) {
      expect((await mint('docs/a.txt', 'viewer')).status).toBe(403);
    }
    expect((await mint('docs/a.txt')).status).toBe(201);
  });

  it('[US-STO-02][unit][sdk] the link allowance comes back after the window', () => {
    const t0 = 1_000_000;
    for (let index = 0; index < LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE; index += 1) {
      expect(refuseLinkRequest(WORKSPACE, t0), `request ${index + 1}`).toBeNull();
    }
    const refused = refuseLinkRequest(WORKSPACE, t0);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('60');
    expect(refuseLinkRequest(WORKSPACE, t0 + 60_000)).toBeNull();
  });
});

describe('signed uploads over an existing file', () => {
  // @story US-STO-02
  it('[US-STO-02][api][sdk] a signed upload over an existing file keeps the old version readable until complete', async () => {
    const old = await save('docs/a.txt', 'old');
    expect((await mint('docs/a.txt', 'owner', 3)).status).toBe(201);
    await putPending('docs/a.txt', bytesOf('new'));
    expect(await read('docs/a.txt')).toBe('old');

    const done = await complete('docs/a.txt');
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await read('docs/a.txt')).toBe('new');
    expect(await root.head(storageObjectName(WORKSPACE, 'files', old.objectId ?? ''))).toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] complete records the new object id and checksum, drops the old object and searches', async () => {
    const old = await save('docs/a.txt', 'old');
    expect((await mint('docs/a.txt', 'owner', 11)).status).toBe(201);
    const key = await putPending('docs/a.txt', bytesOf('fresh words'));
    expect((await complete('docs/a.txt')).status).toBe(200);

    const row = await storage.get(ctx, 'files', 'docs/a.txt');
    expect(row?.objectId).not.toBe(old.objectId);
    // The file is a copy the upload link never named; the uploaded object is gone.
    expect(key).not.toBe(storageObjectName(WORKSPACE, 'files', row?.objectId ?? ''));
    expect(await root.head(key)).toBeNull();
    expect(row?.sha256).toBe(createHash('sha256').update('fresh words').digest('hex'));
    expect(await root.head(storageObjectName(WORKSPACE, 'files', old.objectId ?? ''))).toBeNull();
    const found = (await (await search('fresh')).json()) as { hits: Array<{ path: string }> };
    expect(found.hits.map((hit) => hit.path)).toEqual(['docs/a.txt']);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] an oversize object is deleted with its pending row and the old version stays', async () => {
    await save('docs/a.txt', 'old');
    expect((await mint('docs/a.txt', 'owner', 3)).status).toBe(201);
    const key = await putPending('docs/a.txt', bytesOf('far too long'));

    const done = await complete('docs/a.txt');
    expect(done.status).toBe(409);
    expect(await done.text()).toContain('upload_not_verified');
    expect(await root.head(key)).toBeNull();
    expect(await catalog.forWorkspaceSync(WORKSPACE).countPending()).toBe(0);
    expect(await read('docs/a.txt')).toBe('old');
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] a missing object answers 409 and the row stays pending', async () => {
    await save('docs/a.txt', 'old');
    expect((await mint('docs/a.txt')).status).toBe(201);
    const done = await complete('docs/a.txt');
    expect(done.status).toBe(409);
    expect(await catalog.forWorkspaceSync(WORKSPACE).countPending()).toBe(1);
    expect(await read('docs/a.txt')).toBe('old');
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] completing twice answers the ready file again', async () => {
    await mint('docs/a.txt');
    await putPending('docs/a.txt');
    const first = await complete('docs/a.txt');
    expect(first.status).toBe(200);
    const again = await complete('docs/a.txt');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] completing a path that has no upload and no file answers 404', async () => {
    expect((await complete('docs/none.txt')).status).toBe(404);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] a viewer can neither mint nor complete, and no row appears', async () => {
    expect((await mint('docs/a.txt', 'viewer')).status).toBe(403);
    expect((await mint('docs/b.txt')).status).toBe(201);
    await putPending('docs/b.txt');
    expect((await complete('docs/b.txt', 'viewer')).status).toBe(403);
    expect(await pendingRow()).toBeNull();
    expect(await storage.get(ctx, 'files', 'docs/b.txt')).toBeNull();
  });
});

describe('backends that cannot bind the upload length', () => {
  // @story US-STO-02
  it('[US-STO-02][api][sdk] the link is signed bound when the store can bind and unbound when it cannot', async () => {
    const bound: SignedUrlRequest[] = [];
    root = signingRoot(true, bound);
    installFiles();
    expect((await mint('docs/a.txt')).status).toBe(201);
    expect(bound[0]).toMatchObject({ method: 'PUT', requireBoundContentLength: true });

    const unbound: SignedUrlRequest[] = [];
    root = signingRoot(false, unbound);
    installFiles();
    expect((await mint('docs/b.txt')).status).toBe(201);
    expect(unbound[0]).toMatchObject({ method: 'PUT', requireBoundContentLength: false });
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] an oversize replacement is deleted at complete and the old file stays readable', async () => {
    root = signingRoot(false);
    installFiles();
    await save('docs/a.txt', 'old');
    expect((await mint('docs/a.txt', 'owner', 3)).status).toBe(201);
    const key = await putPending('docs/a.txt', bytesOf('far too long'));

    expect((await complete('docs/a.txt')).status).toBe(409);
    expect(await root.head(key)).toBeNull();
    expect(await read('docs/a.txt')).toBe('old');
  });
});
