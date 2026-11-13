/**
 * The files route handlers, imported as Next.js will import them and driven with real `Request`
 * objects. Mirrors `apps/web/server/agents/routes.test.ts`'s shape — see that file's header for
 * why a header-driven test resolver is the strongest position to give an attacker, and what this
 * file cannot exercise (Next.js's own routing — `tests/route-inventory.test.ts` covers that).
 *
 * The shared harness is `routes.test-support.ts`; the topic suites beside this file are
 * `reserved-prefix`, `verification`, `ownership`, `ownership.postgres`, `no-byte-reads`, `pending`
 * and `replacement` (`*.routes.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resourcePathHeaders } from '../../contracts/files';
import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';
import { PATCH as renameRoute } from '../../app/api/files/[id]/route';
import { encodeFileId } from './file-id';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { seedCatalogFile } from '@agent-workspace/core/db';
import {
  WORKSPACE_A,
  WORKSPACE_B,
  download,
  idContext,
  installDefaultWorld,
  installSingleWorkspaceWorld,
  remove,
  rename,
  req,
  upload,
} from './routes.test-support';

beforeEach(() => {
  installDefaultWorld();
});

afterEach(() => {
  clearApplicationContext();
});

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
    const uploaded = await upload('instructions.md', '# hello\n', { contentType: 'text/markdown' });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const body = (await uploaded.json()) as { file: { id: string; path: string } };
    expect(body.file.path).toBe('instructions.md');

    const list = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { files: Array<{ path: string; id: string }> };
    expect(listed.files.map((f) => f.path)).toEqual(['instructions.md']);
    expect(listed.files[0]?.id).toBe(body.file.id);
  });

  it('requires the x-file-path header', async () => {
    const response = await uploadRoute(
      req('POST', '/api/files', { workspace: WORKSPACE_A, body: new Uint8Array([1]) }),
    );
    expect(response.status).toBe(400);
  });

  it('accepts a percent-encoded UTF-8 filename from the browser and lists the original path', async () => {
    const filePath = '案件/見積書_日本語.txt';
    const uploaded = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        body: new TextEncoder().encode('日本語の本文'),
        headers: resourcePathHeaders('x-file-path', filePath),
        contentType: 'text/plain',
      }),
    );

    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    expect(await uploaded.json()).toMatchObject({ file: { path: filePath } });

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
    const response = await upload(filePath, text, { workspace });
    expect(response.status, await response.clone().text()).toBe(201);
    // The `:id` routes take the path's own id, which is not the catalog row id the upload returns.
    return encodeFileId(filePath);
  }

  it('downloads exactly the uploaded bytes', async () => {
    await uploadAndGetId(WORKSPACE_A, 'a.txt', 'hello\n');
    const response = await download('a.txt');
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('hello\n', 'utf8'));
  });

  it('renames a file, and the old id 404s afterward', async () => {
    await uploadAndGetId(WORKSPACE_A, 'a.txt', 'x');
    const renamed = await rename('a.txt', 'b.txt');
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect((await download('a.txt')).status).toBe(404);
    expect((await download('b.txt')).status).toBe(200);
  });

  it('deletes a file', async () => {
    await uploadAndGetId(WORKSPACE_A, 'a.txt', 'x');
    expect((await remove('a.txt')).status).toBe(204);
    expect((await download('a.txt')).status).toBe(404);
  });

  it("one workspace cannot download, rename or delete a file by another workspace's id", async () => {
    await uploadAndGetId(WORKSPACE_A, 'secret.txt', 'top secret');
    const asB = { workspace: WORKSPACE_B };

    expect((await download('secret.txt', asB)).status).toBe(404);

    // a missing path is an idempotent delete; B's catalog holds no such row
    expect((await remove('secret.txt', asB)).status).toBe(204);

    // Proof the file in A is untouched by B's no-op delete.
    expect((await download('secret.txt')).status).toBe(200);

    expect((await rename('secret.txt', 'stolen.txt', asB)).status).toBe(404);
  });

  it('two concurrent renames to one destination: one wins, one 409s, no bytes are lost (FX-2)', async () => {
    await uploadAndGetId(WORKSPACE_A, 'a.txt', 'bytes of a');
    await uploadAndGetId(WORKSPACE_A, 'b.txt', 'bytes of b');
    const responses = await Promise.all([rename('a.txt', 'same.txt'), rename('b.txt', 'same.txt')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const texts: string[] = [];
    for (const filePath of ['a.txt', 'b.txt', 'same.txt']) {
      const downloaded = await download(filePath);
      if (downloaded.status === 200) texts.push(await downloaded.text());
    }
    expect(texts.sort()).toEqual(['bytes of a', 'bytes of b']);
  });

  it('two concurrent renames of one source: one wins, the other finds nothing to move (FX-2)', async () => {
    await uploadAndGetId(WORKSPACE_A, 'src.txt', 'bytes of src');
    const responses = await Promise.all([rename('src.txt', 'd1.txt'), rename('src.txt', 'd2.txt')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);

    const present: string[] = [];
    for (const filePath of ['src.txt', 'd1.txt', 'd2.txt']) {
      if ((await download(filePath)).status === 200) present.push(filePath);
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
    const fixture = installSingleWorkspaceWorld({ catalogs: catalog });
    // No catalog row: written outside the catalogued paths (or before the catalog existed). The
    // listing reads the catalog only, so it does not appear.
    await fixture.legacy
      .forWorkspace(WORKSPACE_A)
      .write('legacy.txt', new TextEncoder().encode('old'), {});

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
