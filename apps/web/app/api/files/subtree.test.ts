/**
 * `DELETE`/`PATCH /api/files/:id` against a folder path, driven through the real route handlers —
 * issue #131's verifier attacks, reproduced against the code that ships, over the catalog service
 * (in-memory catalog and object store; the files routes answer 503 without it). Named
 * `subtree.test.ts`, not `route.test.ts`: `tests/route-inventory.test.ts` treats any
 * `apps/web/app/**` file named `route.<anything>` as a route Next.js serves.
 */
// @story US-STO-02
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemoryCatalogStore } from '../../../server/resources/catalog-store.memory';

import { GET as listRoute, POST as uploadRoute } from './route';
import { DELETE as deleteRoute, GET as downloadRoute, PATCH as renameRoute } from './[id]/route';
import { createCatalogFilesWorld } from '../../../server/files/catalog-runtime-fixtures';
import { encodeFileId } from '../../../server/files/file-id';
import { type WorkspaceResolution } from '../../../server/files/runtime';
import { createMemoryDirectory } from '../../../server/rbac/memory-directory';
import { Principal } from '../../../server/rbac/principal';
import { installTestDomains } from '../../../server/application-context-fixtures';
import { clearApplicationContext } from '../../../server/application-context';

const WORKSPACE_A = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_HEADER = 'x-test-workspace';

beforeEach(() => {
  const world = createCatalogFilesWorld({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE_A].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? { kind: 'unauthenticated', reason: 'no test workspace header' }
          : { kind: 'workspace', workspaceId },
      );
    },
  });
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
          { email: 'owner@example.test', name: 'Owner', workspaceId: WORKSPACE_A, role: 'owner' },
        ],
      }),
      identify(request: Request) {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? null
            : Principal.fromApiKey({
                principalId: 'd67565b8-5eed-4378-bc0e-62d807a93567',
                apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                workspaceId,
                role: 'owner',
                label: 'File subtree test key',
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
  options: { body?: BodyInit; contentType?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set(WORKSPACE_HEADER, WORKSPACE_A);
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

async function upload(filePath: string, text: string): Promise<void> {
  const response = await uploadRoute(
    req('POST', '/api/files', {
      body: new TextEncoder().encode(text),
      headers: { 'x-file-path': filePath },
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
}

async function listPaths(prefix?: string): Promise<string[]> {
  const query = prefix === undefined ? '' : `?path=${encodeURIComponent(prefix)}`;
  const response = await listRoute(req('GET', `/api/files${query}`));
  const body = (await response.json()) as { files: Array<{ path: string }> };
  return body.files.map((f) => f.path);
}

async function createFolder(folderPath: string): Promise<Response> {
  return uploadRoute(req('POST', '/api/files', { headers: { 'x-folder-path': folderPath } }));
}

async function move(from: string, newPath: string): Promise<Response> {
  const id = encodeFileId(from);
  return renameRoute(
    req('PATCH', `/api/files/${id}`, {
      body: JSON.stringify({ newPath }),
      contentType: 'application/json',
    }),
    idContext(id),
  );
}

async function status(filePath: string): Promise<number> {
  const id = encodeFileId(filePath);
  return (await downloadRoute(req('GET', `/api/files/${id}`), idContext(id))).status;
}

const errorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('folder delete and move, the cases beyond the two verifier attacks', () => {
  it('recursive delete removes every descendant and reports them all', async () => {
    await upload('a/b/c.txt', 'c');
    await upload('a/b/d.txt', 'd');
    const id = encodeFileId('a');
    const deleted = await deleteRoute(
      req('DELETE', `/api/files/${id}?recursive=true`),
      idContext(id),
    );
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as { status: string; deleted: string[] };
    expect(body.status).toBe('ok');
    expect(body.deleted.sort()).toEqual(['a/b/c.txt', 'a/b/d.txt']);
    expect(await status('a/b/c.txt')).toBe(404);
    expect(await status('a/b/d.txt')).toBe(404);
  });

  it('an explicit empty folder is deleted without needing ?recursive=true', async () => {
    await createFolder('empty');
    const id = encodeFileId('empty');
    const result = await deleteRoute(req('DELETE', `/api/files/${id}`), idContext(id));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: 'ok' });
    expect(await listPaths()).toEqual([]);
  });

  it('moves an explicit empty folder', async () => {
    await createFolder('a/empty');
    const result = await move('a/empty', 'moved-empty');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: 'ok' });
    expect(await listPaths('moved-empty')).toEqual([]);
    expect(await listPaths()).toContain('moved-empty');
    expect(await listPaths('a')).toEqual([]);
  });

  it('a no-op rename to the identical path succeeds trivially', async () => {
    await upload('a/b.txt', 'x');
    const result = await move('a', 'a');
    expect(result.status).toBe(200);
    expect(await status('a/b.txt')).toBe(200);
  });

  it('refuses a destination that already exists, changing neither side', async () => {
    await upload('a/b.txt', 'x');
    await upload('z/existing.txt', 'taken');
    const result = await move('a', 'z');
    expect(result.status).toBe(409);
    expect(await errorCode(result)).toBe('name_conflict');
    expect(await status('a/b.txt')).toBe(200);
    expect(await listPaths('z')).toEqual(['z/existing.txt']);
  });

  it('refuses a rename that differs only by letter case', async () => {
    await upload('Docs/readme.txt', 'x');
    const result = await move('Docs', 'docs');
    expect(result.status).toBe(409);
    expect(await errorCode(result)).toBe('name_conflict');
    expect(await status('Docs/readme.txt')).toBe(200);
  });

  it('reserves the runner-private directory as both a source and a destination', async () => {
    await upload('a/b.txt', 'x');
    for (const [from, to] of [
      ['a', '.claude/stolen'],
      ['.claude', 'exfiltrated'],
    ] as const) {
      const result = await move(from, to);
      expect(result.status, `${from} -> ${to}`).toBe(400);
      expect(await errorCode(result)).toBe('reserved_path');
    }
  });

  it('a folder that does not exist is 404', async () => {
    expect((await move('nope', 'also-nope')).status).toBe(404);
  });

  it('refuses a destination that names the empty-folder marker in any segment', async () => {
    await upload('a/b.txt', 'x');
    const marker = '.agent-workspace-empty-folder';
    for (const newPath of [marker, `z/${marker}`, `${marker}/z`]) {
      const result = await move('a', newPath);
      expect(result.status, newPath).toBe(400);
      expect(await errorCode(result)).toBe('reserved_path');
    }
    expect(await status('a/b.txt')).toBe(200);
  });
});

describe('DELETE /api/files/:id on a folder (issue #131, verifier attack 1)', () => {
  it('refuses a non-empty folder without ?recursive=true, then deletes it fully with the flag', async () => {
    await upload('a/b/c.txt', 'c');
    await upload('a/b/d.txt', 'd');
    const id = encodeFileId('a');

    const refused = await deleteRoute(req('DELETE', `/api/files/${id}`), idContext(id));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'folder_not_empty' } });
    // Nothing was touched by the refusal.
    expect(
      (
        await downloadRoute(
          req('GET', `/api/files/${encodeFileId('a/b/c.txt')}`),
          idContext(encodeFileId('a/b/c.txt')),
        )
      ).status,
    ).toBe(200);

    const deleted = await deleteRoute(
      req('DELETE', `/api/files/${id}?recursive=true`),
      idContext(id),
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toMatchObject({ status: 'ok' });
    expect(await listPaths()).toEqual([]);
  });

  it('deleting a plain file is unaffected — still 204, still idempotent', async () => {
    await upload('solo.txt', 'x');
    const id = encodeFileId('solo.txt');
    expect((await deleteRoute(req('DELETE', `/api/files/${id}`), idContext(id))).status).toBe(204);
    expect((await deleteRoute(req('DELETE', `/api/files/${id}`), idContext(id))).status).toBe(204);
  });

  it('deleting a path that never existed is still the idempotent 204, not a 404', async () => {
    const id = encodeFileId('never/existed');
    expect((await deleteRoute(req('DELETE', `/api/files/${id}`), idContext(id))).status).toBe(204);
  });
});

describe('PATCH /api/files/:id on a folder (issue #131, verifier attack 2)', () => {
  it('moves a folder, preserves its content under the new path, and the old path is gone', async () => {
    await upload('a/b/c.txt', 'hello');
    const id = encodeFileId('a');

    const renamed = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        body: JSON.stringify({ newPath: 'z' }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await renamed.json()).toMatchObject({ status: 'ok', moved: 3 }); // the rows renamed: a, a/b and a/b/c.txt

    const newFileId = encodeFileId('z/b/c.txt');
    const download = await downloadRoute(
      req('GET', `/api/files/${newFileId}`),
      idContext(newFileId),
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('hello');

    const oldFileId = encodeFileId('a/b/c.txt');
    expect(
      (await downloadRoute(req('GET', `/api/files/${oldFileId}`), idContext(oldFileId))).status,
    ).toBe(404);
    expect(await listPaths('a')).toEqual([]);
  });

  it('refuses to move a folder into its own descendant', async () => {
    await upload('a/b/c.txt', 'x');
    const id = encodeFileId('a');
    const result = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        body: JSON.stringify({ newPath: 'a/b' }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: 'self_descendant' } });
    expect(await listPaths('a')).toEqual(['a/b']);
  });

  it('renaming a plain file is unaffected by the folder branch', async () => {
    await upload('a.txt', 'x');
    const id = encodeFileId('a.txt');
    const result = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        body: JSON.stringify({ newPath: 'b.txt' }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(result.status, await result.clone().text()).toBe(200);
    const body = (await result.json()) as { file: { path: string } };
    expect(body.file.path).toBe('b.txt');
  });

  it('renaming a path that never existed is still 404', async () => {
    const id = encodeFileId('never/existed');
    const result = await renameRoute(
      req('PATCH', `/api/files/${id}`, {
        body: JSON.stringify({ newPath: 'x' }),
        contentType: 'application/json',
      }),
      idContext(id),
    );
    expect(result.status).toBe(404);
  });
});
