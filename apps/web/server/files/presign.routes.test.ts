/**
 * `POST /api/files/:id/upload-urls` and `/download-urls` (issue #251, N-4), driven with real
 * `Request` objects over the catalog service. The object store here signs by spelling the request
 * into a URL, so these cases need no object-store service; the bytes-on-the-wire cases are in
 * `presign.network.test.ts`.
 */
// @story US-STO-05
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';

import { POST as downloadUrlRoute } from '../../app/api/files/[id]/download-urls/route';
import { POST as uploadUrlRoute } from '../../app/api/files/[id]/upload-urls/route';
import {
  bytesToStream,
  createInMemoryObjectStore,
  storageObjectName,
  workspaceFolder,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';

import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createCatalogFilesWorld, type CatalogFilesWorld } from './catalog-runtime-fixtures';
import { encodeFileId } from './file-id';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { seedCatalogFile } from '@agent-workspace/core/db';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const ACTOR_HEADER = 'x-test-actor';
const ME = '37d41bbb-42d1-4a16-8f5d-de3fef42eed0';
const SOMEONE_ELSE = '55555555-5555-4555-8555-555555555555';
const ctx = { workspaceId: WORKSPACE, principalId: ME, userId: null };

type Actor = 'owner' | 'admin' | 'builder' | 'viewer' | 'session' | 'run';

function principalFor(actor: Actor): Principal {
  const base = Principal.fromApiKey({
    principalId: ME,
    apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: WORKSPACE,
    role: actor === 'session' || actor === 'run' ? 'admin' : actor,
    label: 'Presign route test key',
  });
  if (actor === 'session')
    return Principal.fromBrowserToken(base, { kind: 'session', id: SESSION });
  if (actor === 'run') return Principal.fromBrowserToken(base, { kind: 'run', id: SESSION });
  return base;
}

/** The in-memory object store, which cannot sign: what a deployment on a plain store looks like. */
const unsigningObjects = (): ObjectStore => createInMemoryObjectStore();

/**
 * An in-memory store that also signs: the URL spells out what the route asked the store for.
 * `bindsLength: false` behaves like Azure Blob, whose SAS cannot carry an upload length.
 */
function signingObjects(bindsLength = true): ObjectStore {
  const inner = createInMemoryObjectStore();
  return {
    ...inner,
    capabilities: { ...inner.capabilities, sign: true, boundLengthSign: bindsLength },
    createSignedUrl: (key, request) => {
      const url = new URL(`https://store.invalid/${key}`);
      url.searchParams.set('ttl', String(request.expiresInSeconds));
      if (request.contentLength !== undefined) {
        url.searchParams.set('length', String(request.contentLength));
      }
      if (request.responseContentType !== undefined) {
        url.searchParams.set('response-content-type', request.responseContentType);
      }
      if (request.responseDisposition !== undefined) {
        url.searchParams.set('response-content-disposition', request.responseDisposition);
      }
      const headers: Record<string, string> = {};
      if (request.contentType !== undefined && request.contentType !== null) {
        headers['content-type'] = request.contentType;
      }
      return Promise.resolve({ url: url.toString(), headers });
    },
  };
}

let world: CatalogFilesWorld;

function configure(
  objects: ObjectStore,
  catalogs = createInMemoryCatalogStore(),
): CatalogFilesWorld {
  world = createCatalogFilesWorld({
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    objects,
    catalogs,
  });
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  return world;
}

beforeEach(() => {
  configure(signingObjects());
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
          { email: 'owner@example.test', name: 'Owner', workspaceId: WORKSPACE, role: 'owner' },
        ],
      }),
      identify(request: Request) {
        const actor = request.headers.get(ACTOR_HEADER);
        return Promise.resolve(actor === null ? null : principalFor(actor as Actor));
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

function mint(
  route: typeof uploadUrlRoute,
  sub: 'upload-urls' | 'download-urls',
  filePath: string,
  body: unknown,
  actor: Actor | null = 'owner',
): Promise<Response> {
  return route(
    new Request(`https://example.invalid/api/files/${encodeFileId(filePath)}/${sub}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(actor === null ? {} : { [ACTOR_HEADER]: actor }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: encodeFileId(filePath) }) },
  );
}

const upload = (
  filePath: string,
  actor: Actor | null = 'owner',
  body: unknown = { sizeBytes: 5 },
) => mint(uploadUrlRoute, 'upload-urls', filePath, body, actor);
const download = (filePath: string, actor: Actor | null = 'owner') =>
  mint(downloadUrlRoute, 'download-urls', filePath, {}, actor);

/** A ready file, saved through the catalog service as a relay upload would. */
async function seed(filePath: string): Promise<void> {
  const saved = await world.storage.save(ctx, {
    area: 'files',
    path: filePath,
    maxBytes: 1024,
    replace: true,
    body: bytesToStream(new TextEncoder().encode('bytes')),
  });
  if (!saved.ok) throw new Error(`seeding ${filePath} was refused: ${saved.code}`);
}

describe('POST /api/files/:id/upload-urls', () => {
  it('mints a PUT URL on the object store for a pending row, and no-store', async () => {
    const response = await upload('docs/a.txt', 'owner', {
      sizeBytes: 5,
      contentType: 'text/plain',
      ttlSeconds: 120,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      url: string;
      method: string;
      headers: Record<string, string>;
      expiresAt: string;
      path: string;
    };
    const url = new URL(body.url);
    expect(url.origin).toBe('https://store.invalid');
    expect(url.searchParams.get('ttl')).toBe('120');
    expect(url.searchParams.get('length')).toBe('5');
    expect(body.method).toBe('PUT');
    expect(body.path).toBe('docs/a.txt');
    expect(body.headers['content-type']).toBe('text/plain');
    const lifetime = new Date(body.expiresAt).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(110_000);
    expect(lifetime).toBeLessThanOrEqual(120_000);

    // The link names the pending row's object, not the path; the row is not a file yet.
    const catalog = await world.catalogs.forWorkspace(WORKSPACE);
    const pending = await catalog.pending('docs/a.txt');
    expect(pending?.objectId).not.toBeNull();
    // The signed key lies under this workspace's object folder and no other workspace's.
    const signedKey = url.pathname.slice(1);
    expect(signedKey).toBe(storageObjectName(WORKSPACE, 'files', pending?.objectId ?? ''));
    expect(signedKey.startsWith(workspaceFolder(WORKSPACE))).toBe(true);
    expect(signedKey.startsWith(workspaceFolder(crypto.randomUUID()))).toBe(false);
    expect(url.pathname).not.toContain('docs/a.txt');
    expect(await world.storage.get(ctx, 'files', 'docs/a.txt')).toBeNull();
  });

  it('defaults the lifetime to five minutes', async () => {
    const body = (await (await upload('a.txt')).json()) as { url: string };
    expect(new URL(body.url).searchParams.get('ttl')).toBe('300');
  });

  it('refuses a Viewer, who cannot write files', async () => {
    expect((await upload('a.txt', 'viewer')).status).toBe(403);
  });

  it('refuses a Builder on another member’s file and admits their own and a new path', async () => {
    const catalogs = createInMemoryCatalogStore();
    for (const [filePath, ownerPrincipalId] of [
      ['theirs.txt', SOMEONE_ELSE],
      ['mine.txt', ME],
    ] as const) {
      await seedCatalogFile(catalogs.forWorkspaceSync(WORKSPACE), {
        path: filePath,
        kind: 'file',
        sizeBytes: 1,
        contentType: 'text/plain',
        ownerPrincipalId,
      });
    }
    configure(signingObjects(), catalogs);
    expect((await upload('theirs.txt', 'builder')).status).toBe(403);
    expect((await upload('mine.txt', 'builder')).status).toBe(201);
    expect((await upload('new.txt', 'builder')).status).toBe(201);
  });

  it('answers 401 when no credential identifies the caller', async () => {
    expect((await upload('a.txt', null)).status).toBe(401);
  });

  it.each([
    ['a store that binds the upload length (S3, GCS)', () => signingObjects()],
    ['a store that cannot bind it (Azure Blob)', () => signingObjects(false)],
    ['a store that cannot sign', unsigningObjects],
  ])('refuses a session token as out of scope on %s', async (_name, objects) => {
    configure(objects());
    for (const target of [
      `.attachments/${SESSION}/u1/a.txt`,
      `.attachments/${OTHER_SESSION}/u1/a.txt`,
      'a.txt',
    ]) {
      const response = await upload(target, 'session');
      expect(response.status, target).toBe(403);
      expect(await response.json(), target).toMatchObject({
        error: { code: 'token_out_of_scope' },
      });
    }
  });

  it('keeps .attachments/ for visitors: a member mints neither an upload nor a download URL there', async () => {
    const mine = `.attachments/${SESSION}/u1/a.txt`;
    const up = await upload(mine, 'owner');
    expect(up.status).toBe(400);
    expect(await up.json()).toMatchObject({ error: { code: 'reserved_path' } });
    const down = await download(mine, 'owner');
    expect(down.status).toBe(404);
    expect(await down.json()).toMatchObject({ error: { code: 'file_not_found' } });
  });

  it('refuses a run-scoped token as out of scope', async () => {
    const response = await upload(`.attachments/${SESSION}/a.txt`, 'run');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'token_out_of_scope' } });
  });

  it('refuses reserved paths', async () => {
    for (const reserved of [
      '.claude/settings.json',
      'skill-revisions/x/1/SKILL.md',
      '.agent-workspace-empty-folder',
      'docs/.agent-workspace-empty-folder',
    ]) {
      expect((await upload(reserved)).status, reserved).toBe(400);
    }
  });

  it('refuses a path that is already a folder, as the relay upload does', async () => {
    await seed('docs/a.txt');
    const made = await world.storage.createFolder(ctx, 'empty');
    expect(made.ok).toBe(true);
    const response = await upload('docs');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'name_conflict' } });
    expect((await upload('empty')).status).toBe(409);
    expect((await upload('docs/b.txt')).status).toBe(201);
  });

  it('refuses a malformed or out-of-range body', async () => {
    for (const body of [
      '{',
      {},
      { sizeBytes: -1 },
      { sizeBytes: SIGNED_UPLOAD_HARD_MAX_BYTES + 1 },
      { sizeBytes: 1, ttlSeconds: 59 },
      { sizeBytes: 1, ttlSeconds: 901 },
      { sizeBytes: 1, extra: true },
    ]) {
      const response = await upload('a.txt', 'owner', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses an id that names no legal path', async () => {
    const response = await uploadUrlRoute(
      new Request(
        `https://example.invalid/api/files/${encodeFileId('../escape.txt')}/upload-urls`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', [ACTOR_HEADER]: 'owner' },
          body: '{"sizeBytes":1}',
        },
      ),
      { params: Promise.resolve({ id: encodeFileId('../escape.txt') }) },
    );
    expect(response.status).toBe(404);
  });

  it('answers 501 on a store that cannot sign, leaving no pending row, and the relay routes remain', async () => {
    configure(unsigningObjects());
    const response = await upload('a.txt');
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: 'direct_transfer_unsupported' } });
    const catalog = await world.catalogs.forWorkspace(WORKSPACE);
    expect(await catalog.pending('a.txt')).toBeNull();
  });

  it('mints on a store that cannot bind the upload length, because completion checks the size (Azure Blob)', async () => {
    configure(signingObjects(false));
    const response = await upload('a.txt');
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { url: string };
    expect(new URL(body.url).searchParams.get('length')).toBe('5');
  });
});

describe('POST /api/files/:id/download-urls', () => {
  it('mints a GET URL that forces the inert delivery the relay applies', async () => {
    await seed('docs/page.html');
    expect((await download('docs/page.html', 'viewer')).status).toBe(403);
    const response = await download('docs/page.html', 'builder');
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { url: string; method: string; headers: object };
    const url = new URL(body.url);
    expect(body.method).toBe('GET');
    expect(url.origin).toBe('https://store.invalid');
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment;');
  });

  it('names a known inert type as itself', async () => {
    await seed('a.pdf');
    const body = (await (await download('a.pdf')).json()) as { url: string };
    expect(new URL(body.url).searchParams.get('response-content-type')).toBe('application/pdf');
  });

  it('answers 404 for a missing file and for a folder', async () => {
    await seed('docs/a.txt');
    expect((await download('missing.txt')).status).toBe(404);
    expect((await download('docs')).status).toBe(404);
  });

  it('keeps a session token inside its prefix', async () => {
    await seed(`.attachments/${SESSION}/u1/a.txt`);
    expect((await download(`.attachments/${SESSION}/u1/a.txt`, 'session')).status).toBe(201);
    expect((await download('docs/a.txt', 'session')).status).toBe(404);
    expect((await download(`.attachments/${SESSION}/u1/a.txt`, 'run')).status).toBe(403);
  });

  it('answers 501 on a store that cannot sign', async () => {
    configure(unsigningObjects());
    await seed('a.txt');
    const response = await download('a.txt');
    expect(response.status).toBe(501);
  });
});
