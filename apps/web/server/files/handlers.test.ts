/**
 * The behaviour `handlers.ts` and the files routes guarantee about paths, driven through the routes
 * over the catalog service (in-memory catalog and object store), so the suite exercises the same
 * code path production does.
 */
// @story US-STO-02
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';

import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';
import {
  DELETE as deleteRoute,
  GET as downloadRoute,
  PATCH as renameRoute,
} from '../../app/api/files/[id]/route';
import { bytesToStream } from '@agent-workspace/core/storage';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createCatalogFilesWorld, type CatalogFilesWorld } from './catalog-runtime-fixtures';
import { encodeFileId } from './file-id';
import { reservedFileWriteRefusal, requireFilePath } from './handlers';

const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL_ID = '37d41bbb-42d1-4a16-8f5d-de3fef42eed0';

let world: CatalogFilesWorld;

beforeEach(() => {
  world = createCatalogFilesWorld({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE_ID].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_ID }),
  });
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
          { email: 'owner@example.test', name: 'Owner', workspaceId: WORKSPACE_ID, role: 'owner' },
        ],
      }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: PRINCIPAL_ID,
            apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceId: WORKSPACE_ID,
            role: 'owner',
            label: 'Handlers test key',
          }),
        ),
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const idContext = (id: string): { params: Promise<{ id: string }> } => ({
  params: Promise.resolve({ id }),
});
const request = (method: string, url: string, init: RequestInit = {}): Request =>
  new Request(`https://example.invalid${url}`, { method, ...init });

const upload = (path: string, body: string): Promise<Response> =>
  uploadRoute(
    request('POST', '/api/files', {
      body,
      headers: { 'x-file-path': path },
    }),
  );
const createFolder = (path: string): Promise<Response> =>
  uploadRoute(request('POST', '/api/files', { headers: { 'x-folder-path': path } }));
const list = (path: string | null): Promise<Response> =>
  listRoute(request('GET', path === null ? '/api/files' : `/api/files?path=${path}`));
const download = (path: string): Promise<Response> =>
  downloadRoute(request('GET', `/api/files/${encodeFileId(path)}`), idContext(encodeFileId(path)));
const rename = (path: string, newPath: string): Promise<Response> =>
  renameRoute(
    request('PATCH', `/api/files/${encodeFileId(path)}`, {
      body: JSON.stringify({ newPath }),
      headers: { 'content-type': 'application/json' },
    }),
    idContext(encodeFileId(path)),
  );
const remove = (path: string, recursive = false): Promise<Response> =>
  deleteRoute(
    request('DELETE', `/api/files/${encodeFileId(path)}${recursive ? '?recursive=true' : ''}`),
    idContext(encodeFileId(path)),
  );
const errorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;
const listed = async (response: Response): Promise<string[]> =>
  ((await response.json()) as { files: Array<{ kind: string; path: string }> }).files
    .map((f) => `${f.kind}:${f.path}`)
    .sort();
const text = async (response: Response): Promise<string> => await response.text();

describe('upload / download / delete', () => {
  it('uploads a file and returns its resource with the path and type', async () => {
    const response = await upload('instructions.md', '# hello');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { file: { path: string; contentType: string } };
    expect(body.file.path).toBe('instructions.md');
    expect(body.file.contentType).toBe('text/markdown');
  });

  it('downloads exactly the bytes that were uploaded, trailing newline included', async () => {
    await upload('with-nl.txt', 'a\n');
    await upload('without-nl.txt', 'a');
    expect(await text(await download('with-nl.txt'))).toBe('a\n');
    expect(await text(await download('without-nl.txt'))).toBe('a');
  });

  it('downloading a file that was never uploaded is 404', async () => {
    expect((await download('nope.txt')).status).toBe(404);
  });

  it('rejects an upload path that would escape the workspace, before anything is written', async () => {
    const response = await upload('../escape.txt', 'x');
    expect(response.status).toBe(400);
    expect((await download('escape.txt')).status).toBe(404);
  });

  it('reserves the runner private directory regardless of path casing', async () => {
    const refused = await upload('.ClAuDe/settings.json', '{}');
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe('reserved_path');
    await upload('safe.txt', 'safe');
    const moved = await rename('safe.txt', '.CLAUDE/settings.json');
    expect(moved.status).toBe(400);
    expect(await errorCode(moved)).toBe('reserved_path');
    const folder = await createFolder('.cLaUdE/cache');
    expect(folder.status).toBe(400);
    expect(await errorCode(folder)).toBe('reserved_path');
  });

  it('does not upload a file onto an existing explicit folder', async () => {
    await createFolder('reports');
    const response = await upload('reports', 'file');
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('name_conflict');
    expect(await listed(await list(null))).toEqual(['folder:reports']);
  });

  it('delete removes the file, and deleting twice is not an error', async () => {
    await upload('gone.txt', 'bye');
    expect((await remove('gone.txt')).status).toBe(204);
    expect((await download('gone.txt')).status).toBe(404);
    expect((await remove('gone.txt')).status).toBe(204);
  });
});

describe('list', () => {
  it('creates and lists an explicit empty folder, then lists nothing after it is deleted', async () => {
    expect((await createFolder('empty/reports')).status).toBe(201);
    expect(await listed(await list('empty'))).toEqual(['folder:empty/reports']);
    expect(await listed(await list('empty/reports'))).toEqual([]);
    await remove('empty/reports');
    expect(await listed(await list('empty'))).toEqual([]);
  });

  it('does not create a folder at an existing file path', async () => {
    await upload('reports', 'file');
    const response = await createFolder('reports');
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('name_conflict');
    expect((await download('reports')).status).toBe(200);
  });

  it('reports uploaded files and implied folders one level under a prefix', async () => {
    await upload('contracts/agreement.pdf', 'x');
    await upload('instructions.md', '# hi');
    expect(await listed(await list(null))).toEqual(['file:instructions.md', 'folder:contracts']);
  });

  it('rejects a traversal attempt given as the "path" query value', async () => {
    expect((await list('../../etc')).status).toBe(400);
  });
});

describe('rename', () => {
  it('moves a file to a new path and the old path is gone', async () => {
    await upload('old.txt', 'content');
    expect((await rename('old.txt', 'renamed/new.txt')).status).toBe(200);
    expect((await download('old.txt')).status).toBe(404);
    expect(await text(await download('renamed/new.txt'))).toBe('content');
  });

  it('refuses to rename onto an existing file, disturbing neither', async () => {
    await upload('a.txt', 'a');
    await upload('b.txt', 'b');
    expect((await rename('a.txt', 'b.txt')).status).toBe(409);
    expect(await text(await download('a.txt'))).toBe('a');
    expect(await text(await download('b.txt'))).toBe('b');
  });

  it('refuses to rename onto a folder or the private empty-folder marker', async () => {
    await upload('a.txt', 'a');
    await createFolder('reports');
    const onFolder = await rename('a.txt', 'reports');
    expect(onFolder.status).toBe(409);
    expect(await errorCode(onFolder)).toBe('name_conflict');
    const onMarker = await rename('a.txt', 'reports/.agent-workspace-empty-folder');
    expect(onMarker.status).toBe(400);
    expect(await errorCode(onMarker)).toBe('reserved_path');
    expect((await download('a.txt')).status).toBe(200);
  });

  it('rejects a rename target that would escape the workspace', async () => {
    await upload('a.txt', 'a');
    expect((await rename('a.txt', '../../etc/passwd')).status).toBe(400);
    expect((await download('a.txt')).status).toBe(200);
  });

  it('renaming a file that does not exist is 404', async () => {
    expect((await rename('nope.txt', 'x.txt')).status).toBe(404);
  });
});

describe('requireFilePath', () => {
  it('accepts an id this module minted', () => {
    expect(requireFilePath(encodeFileId('a/b.txt'))).toEqual({ ok: true, path: 'a/b.txt' });
  });

  it('reports 404, not 400, for an id that does not decode to a legal key', () => {
    expect(requireFilePath('not-a-real-id')).toMatchObject({ ok: false, result: { status: 404 } });
    expect(requireFilePath(123)).toMatchObject({ ok: false, result: { status: 404 } });
  });

  it('reports 404 for an id that decodes to a traversal attempt', () => {
    const forged = Buffer.from('../../etc/passwd', 'utf8').toString('base64url');
    expect(requireFilePath(forged)).toMatchObject({ ok: false, result: { status: 404 } });
  });
});

describe('reservedFileWriteRefusal', () => {
  it('refuses published revisions, the runner directory and the folder marker, and nothing else', () => {
    for (const key of [
      'skill-revisions/demo/1/SKILL.md',
      'Skill-Revisions/demo/2/x.md',
      '.claude/settings.json',
      'a/.agent-workspace-empty-folder/b',
    ]) {
      expect(reservedFileWriteRefusal(key), key).toMatchObject({
        status: 400,
        body: { error: { code: 'reserved_path' } },
      });
    }
    expect(reservedFileWriteRefusal('notes/skills.md')).toBeNull();
  });
});

describe('published skill revisions are immutable through the files routes (SDK-19, N-1)', () => {
  const KEY = 'skill-revisions/demo/1/SKILL.md';
  const ctx = { workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, userId: null };

  async function seed(path: string, content: string): Promise<void> {
    const saved = await world.storage.save(ctx, {
      area: 'files',
      path,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(utf8(content)),
    });
    if (!saved.ok) throw new Error(`seeding ${path} was refused: ${saved.code}`);
  }

  async function untouched(): Promise<void> {
    expect((await world.storage.get(ctx, 'files', KEY))?.sizeBytes).toBe('frozen'.length);
    expect(await world.storage.get(ctx, 'files', 'skill-revisions/demo/1/extra.md')).toBeNull();
    expect((await world.storage.get(ctx, 'files', 'mine.txt'))?.sizeBytes).toBe('mine'.length);
    expect(await world.storage.get(ctx, 'files', 'stolen.md')).toBeNull();
  }

  beforeEach(async () => {
    await seed(KEY, 'frozen');
    await seed('mine.txt', 'mine');
  });

  const refused = async (response: Response): Promise<void> => {
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('reserved_path');
  };

  it('refuses to overwrite, add to, or create a folder in a published revision', async () => {
    for (const path of [KEY, 'skill-revisions/demo/1/extra.md', 'Skill-Revisions/demo/2/x.md']) {
      await refused(await upload(path, 'changed'));
    }
    await refused(await createFolder('skill-revisions/demo/3'));
    await untouched();
  });

  it('refuses to rename a file or a folder into, or out of, a published revision', async () => {
    await refused(await rename('mine.txt', 'skill-revisions/demo/1/mine.txt'));
    await refused(await rename(KEY, 'stolen.md'));
    await refused(await rename('skill-revisions/demo', 'elsewhere'));
    await untouched();
  });

  it('refuses to delete a file or a folder in a published revision', async () => {
    await refused(await remove(KEY));
    await refused(await remove('skill-revisions/demo', true));
    await untouched();
  });
});
