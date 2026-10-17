/**
 * `DELETE`/`PATCH /api/files/:id` against a folder path, driven through the real route handlers —
 * issue #131's verifier attacks, reproduced against the code that ships. No catalog is wired in
 * (`configureFilesRuntime` below omits it, the same way `routes.test.ts`'s first suite does), so
 * every assertion here is about the `ObjectStore`-level subtree behaviour the route exposes; the
 * catalog-preservation half of the same requirement is proven in
 * `packages/core/src/db/repositories/resource-catalogs.test.ts` and in `routes.test.ts`'s own
 * PostgreSQL-backed suite. Named `subtree.test.ts`, not `route.test.ts`:
 * `tests/route-inventory.test.ts` treats any `apps/web/app/**` file named `route.<anything>` as a
 * route Next.js serves.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as uploadRoute } from './route';
import { DELETE as deleteRoute, GET as downloadRoute, PATCH as renameRoute } from './[id]/route';
import { encodeFileId } from '../../../server/files/file-id';
import { createRepositoryObjectStoreProvider } from '../../../server/files/store';
import { createLocalFilesystemObjectStoreProvider } from '../../../server/files/object-store-bridge';
import {
  clearFilesRuntime,
  configureFilesRuntime,
  type WorkspaceResolution,
} from '../../../server/files/runtime';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createMemoryDirectory } from '../../../server/rbac/memory-directory';
import { Principal } from '../../../server/rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../../../server/rbac/runtime';

const WORKSPACE_A = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_HEADER = 'x-test-workspace';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w9-files-131-routes-'));
  const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_A, slug: 'acme' }]);
  configureFilesRuntime({
    store: createRepositoryObjectStoreProvider({
      store: createLocalFilesystemObjectStoreProvider(rootDir),
      scopes,
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
    expect(await renamed.json()).toMatchObject({ status: 'ok', moved: 1 });

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
