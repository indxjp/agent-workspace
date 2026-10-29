/**
 * Every `/api/files` route runs on the catalog service and nothing else (STO-601 slice 2): with
 * the service each route answers 2xx, and a files runtime without `storage` (what a deployment
 * without `AW_STORAGE_URL` installs) answers `503 files_runtime_not_configured` and stores,
 * moves, deletes or reserves nothing. There is no path-based fallback to the object store.
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as putRoute } from '../../app/api/files/route';
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as moveRoute,
} from '../../app/api/files/[id]/route';
import { POST as downloadUrlsRoute } from '../../app/api/files/[id]/download-urls/route';
import { POST as completeRoute } from '../../app/api/files/[id]/upload-complete/route';
import { POST as uploadUrlsRoute } from '../../app/api/files/[id]/upload-urls/route';
import {
  bytesToStream,
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createCatalogFilesWorld, type CatalogFilesWorld } from './catalog-runtime-fixtures';
import { encodeFileId } from './file-id';

const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const PRINCIPAL = '37d41bbb-42d1-4a16-8f5d-de3fef42eed0';
const ctx = { workspaceId: WORKSPACE, principalId: PRINCIPAL, userId: null };

/** An in-memory root that signs every key, as an S3-style store does. */
function signingRoot(): ObjectStore {
  const store = createInMemoryObjectStore();
  return {
    ...store,
    capabilities: { ...store.capabilities, sign: true, boundLengthSign: true },
    createSignedUrl: (key) => Promise.resolve({ url: `https://store.invalid/${key}`, headers: {} }),
  };
}

function install(world: CatalogFilesWorld): void {
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
          { email: 'owner@example.test', name: 'Owner', workspaceId: WORKSPACE, role: 'owner' },
        ],
      }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: PRINCIPAL,
            apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceId: WORKSPACE,
            role: 'owner',
            label: 'Catalog-only test key',
          }),
        ),
    },
  });
}

const world = (withStorage: boolean): CatalogFilesWorld =>
  createCatalogFilesWorld({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'workspace-0' }]),
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    objects: signingRoot(),
    withStorage,
  });

const url = (path: string) => `https://example.invalid${path}`;
const idContext = (filePath: string) => ({
  params: Promise.resolve({ id: encodeFileId(filePath) }),
});
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Bytes written straight through the service, so the route under test has something to act on. */
async function seedFile(w: CatalogFilesWorld, path: string, text: string): Promise<void> {
  const saved = await w.storage.save(ctx, {
    area: 'files',
    path,
    body: bytesToStream(new TextEncoder().encode(text)),
    maxBytes: 1024,
    replace: true,
  });
  expect(saved.ok).toBe(true);
}

/** A pending upload reserved through the service, with its bytes already in the object store. */
async function seedPendingUpload(w: CatalogFilesWorld, path: string): Promise<void> {
  const reserved = await w.storage.reserveUpload(ctx, {
    path,
    sizeBytes: 5,
    mayReplace: () => Promise.resolve(true),
  });
  expect(reserved.ok).toBe(true);
  const pending = await (await w.catalogs.forWorkspace(WORKSPACE)).pending(path);
  if (pending?.objectId === undefined || pending.objectId === null) throw new Error('no upload');
  await w.objects.write(
    storageObjectName(WORKSPACE, 'files', pending.objectId),
    new TextEncoder().encode('hello'),
    {
      contentType: 'text/plain',
    },
  );
}

/** Everything a route could have changed: catalog rows (pending ones too) and stored objects. */
async function snapshot(w: CatalogFilesWorld): Promise<string> {
  const repository = await w.catalogs.forWorkspace(WORKSPACE);
  return JSON.stringify({
    rows: await repository.listFiles(),
    pending: await repository.countPending(),
    objects: (await w.objects.listPage('')).entries,
  });
}

interface RouteCase {
  /** The status the route answers over the catalog service. */
  readonly ok: number;
  readonly seed?: (w: CatalogFilesWorld) => Promise<void>;
  readonly call: () => Promise<Response>;
}

const DOC = 'docs/a.txt';
const cases = {
  list: {
    ok: 200,
    seed: (w) => seedFile(w, DOC, 'hello'),
    call: () => listRoute(new Request(url('/api/files?path=docs'))),
  },
  get: {
    ok: 200,
    seed: (w) => seedFile(w, DOC, 'hello'),
    call: () => getRoute(new Request(url(`/api/files/${encodeFileId(DOC)}`)), idContext(DOC)),
  },
  put: {
    ok: 201,
    call: () =>
      putRoute(
        new Request(url('/api/files'), {
          method: 'POST',
          body: 'hello',
          headers: { 'x-file-path': 'new.txt' },
        }),
      ),
  },
  move: {
    ok: 200,
    seed: (w) => seedFile(w, DOC, 'hello'),
    call: () =>
      moveRoute(
        new Request(url(`/api/files/${encodeFileId(DOC)}`), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ newPath: 'docs/b.txt' }),
        }),
        idContext(DOC),
      ),
  },
  delete: {
    ok: 204,
    seed: (w) => seedFile(w, DOC, 'hello'),
    call: () =>
      deleteRoute(
        new Request(url(`/api/files/${encodeFileId(DOC)}`), { method: 'DELETE' }),
        idContext(DOC),
      ),
  },
  downloadUrls: {
    ok: 201,
    seed: (w) => seedFile(w, DOC, 'hello'),
    call: () =>
      downloadUrlsRoute(
        new Request(url(`/api/files/${encodeFileId(DOC)}/download-urls`), json({})),
        idContext(DOC),
      ),
  },
  uploadUrls: {
    ok: 201,
    call: () =>
      uploadUrlsRoute(
        new Request(
          url(`/api/files/${encodeFileId('big.bin')}/upload-urls`),
          json({ sizeBytes: 5 }),
        ),
        idContext('big.bin'),
      ),
  },
  complete: {
    ok: 200,
    seed: (w) => seedPendingUpload(w, 'big.bin'),
    call: () =>
      completeRoute(
        new Request(url(`/api/files/${encodeFileId('big.bin')}/upload-complete`), {
          method: 'POST',
        }),
        idContext('big.bin'),
      ),
  },
} satisfies Record<string, RouteCase>;

async function withService({ ok, seed, call }: RouteCase): Promise<void> {
  const w = world(true);
  install(w);
  await seed?.(w);
  const response = await call();
  expect(response.status, await response.clone().text()).toBe(ok);
}

async function withoutService({ seed, call }: RouteCase): Promise<void> {
  const w = world(false);
  install(w);
  await seed?.(w);
  const before = await snapshot(w);
  const response = await call();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'files_runtime_not_configured' } });
  expect(await snapshot(w)).toBe(before);
}

describe('the files routes run on the catalog service only', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] GET /api/files lists over the catalog service', () =>
    withService(cases.list));

  // @story US-STO-01
  it('[US-STO-01][api][sdk] GET /api/files lists: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.list));

  // @story US-STO-05
  it('[US-STO-05][api][sdk] GET /api/files/:id downloads over the catalog service', () =>
    withService(cases.get));

  // @story US-STO-05
  it('[US-STO-05][api][sdk] GET /api/files/:id downloads: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.get));

  // @story US-STO-01
  it('[US-STO-01][api][sdk] POST /api/files uploads over the catalog service', () =>
    withService(cases.put));

  // @story US-STO-01
  it('[US-STO-01][api][sdk] POST /api/files uploads: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.put));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] PATCH /api/files/:id moves over the catalog service', () =>
    withService(cases.move));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] PATCH /api/files/:id moves: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.move));

  // @story US-STO-04
  it('[US-STO-04][api][sdk] DELETE /api/files/:id deletes over the catalog service', () =>
    withService(cases.delete));

  // @story US-STO-04
  it('[US-STO-04][api][sdk] DELETE /api/files/:id deletes: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.delete));

  // @story US-STO-05
  it('[US-STO-05][api][sdk] POST /api/files/:id/download-urls signs over the catalog service', () =>
    withService(cases.downloadUrls));

  // @story US-STO-05
  it('[US-STO-05][api][sdk] POST /api/files/:id/download-urls signs: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.downloadUrls));

  // @story US-STO-02
  it('[US-STO-02][api][sdk] POST /api/files/:id/upload-urls reserves over the catalog service', () =>
    withService(cases.uploadUrls));

  // @story US-STO-02
  it('[US-STO-02][api][sdk] POST /api/files/:id/upload-urls reserves: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.uploadUrls));

  // @story US-STO-02
  it('[US-STO-02][api][sdk] POST /api/files/:id/upload-complete completes over the catalog service', () =>
    withService(cases.complete));

  // @story US-STO-02
  it('[US-STO-02][api][sdk] POST /api/files/:id/upload-complete completes: 503 files_runtime_not_configured without a catalog service, nothing stored', () =>
    withoutService(cases.complete));
});

describe('two writers on one path', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  // @story US-STO-01
  it("[US-STO-01][api][sdk] concurrent PUTs to one path leave one ready row holding one writer's bytes", async () => {
    const w = world(true);
    install(w);
    const put = (body: string) =>
      putRoute(
        new Request(url('/api/files'), {
          method: 'POST',
          body,
          headers: { 'x-file-path': 'race.txt' },
        }),
      );

    const responses = await Promise.all([put('first-writer'), put('second-writer!')]);

    // The catalog serialises the two writes: each answers a documented result and one wins.
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(await loser?.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
    const rows = (await (await w.catalogs.forWorkspace(WORKSPACE)).listFiles()).filter(
      (row) => row.path === 'race.txt',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ready' });
    const stored = await w.storage.get(ctx, 'files', 'race.txt');
    expect(stored).not.toBeNull();
    const text = await (
      await getRoute(
        new Request(url(`/api/files/${encodeFileId('race.txt')}`)),
        idContext('race.txt'),
      )
    ).text();
    // The writer that got 201 is the one whose bytes are stored.
    expect(text).toBe(responses[0]?.status === 201 ? 'first-writer' : 'second-writer!');
    expect(rows[0]?.sizeBytes).toBe(text.length);
  });
});

describe('lastModified comes from the catalog row', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  const writtenAt = async (w: CatalogFilesWorld, path: string): Promise<string | undefined> =>
    (await (await w.catalogs.forWorkspace(WORKSPACE)).get(path))?.updatedAt?.toISOString();

  // @story US-STO-01
  it('[US-STO-01][api][sdk] upload, list, rename and upload-complete answer the time the row was written', async () => {
    const w = world(true);
    install(w);

    const put = await cases.put.call();
    expect(put.status).toBe(201);
    const uploaded = ((await put.json()) as { file: { lastModified: string | null } }).file;
    expect(uploaded.lastModified).not.toBeNull();
    expect(uploaded.lastModified).toBe(await writtenAt(w, 'new.txt'));

    await seedFile(w, DOC, 'hello');
    const listed = await cases.list.call();
    const files = ((await listed.json()) as { files: { path: string; lastModified: unknown }[] })
      .files;
    expect(files.find((file) => file.path === DOC)?.lastModified).toBe(await writtenAt(w, DOC));

    const moved = await cases.move.call();
    expect(moved.status).toBe(200);
    const renamed = ((await moved.json()) as { file: { lastModified: string | null } }).file;
    expect(renamed.lastModified).toBe(await writtenAt(w, 'docs/b.txt'));

    await seedPendingUpload(w, 'big.bin');
    const completed = await cases.complete.call();
    expect(completed.status).toBe(200);
    const done = ((await completed.json()) as { file: { lastModified: string | null } }).file;
    expect(done.lastModified).toBe(await writtenAt(w, 'big.bin'));
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] a folder still answers no lastModified', async () => {
    const w = world(true);
    install(w);
    await seedFile(w, DOC, 'hello');
    const listed = await listRoute(new Request(url('/api/files?path=')));
    const files = ((await listed.json()) as { files: { path: string; lastModified: unknown }[] })
      .files;
    expect(files.find((file) => file.path === 'docs')).toMatchObject({ lastModified: null });
  });
});
