/**
 * `moveSubtree` and `deleteSubtree` (`handlers.ts`) against a real local-filesystem `ObjectStore`
 * — issue #131's folder move/rename/delete, exercised the same way `handlers.test.ts` exercises
 * the single-object handlers: no HTTP framework, no database, a real backend rather than a fake
 * one. `catalog: null` throughout, matching every call site here to a request with no catalog
 * wired in (`withWorkspaceObjectStore` already does this when `runtime.catalog` is absent) — the
 * catalog-side guarantee (ids and `agent_files` grants survive a rename) is proven separately in
 * `packages/core/src/db/repositories/resource-catalogs.test.ts`, where a real
 * `ResourceCatalogRepository` exists to prove it against.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFolder,
  deleteSubtree,
  downloadFile,
  listFiles,
  MAX_SUBTREE_OBJECTS,
  moveSubtree,
  uploadFile,
} from './handlers';
import { createLocalFilesystemObjectStoreProvider, type ObjectStore } from './object-store-bridge';

const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';

let rootDir: string;
let store: ObjectStore;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w9-files-131-subtree-'));
  store = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Wraps a real store so its `n`-th call to `method` on `targetKey` throws once, then behaves. */
function withOneFailure(
  inner: ObjectStore,
  method: 'delete' | 'copyObject',
  targetKey: string,
): ObjectStore {
  let failed = false;
  return {
    ...inner,
    async delete(key) {
      if (method === 'delete' && key === targetKey && !failed) {
        failed = true;
        throw new Error('injected failure');
      }
      return inner.delete(key);
    },
    async copyObject(source, destination) {
      if (method === 'copyObject' && source === targetKey && !failed) {
        failed = true;
        throw new Error('injected failure');
      }
      return inner.copyObject(source, destination);
    },
  };
}

describe('deleteSubtree', () => {
  it('answers null when nothing exists at or under the path (the idempotent-204 case belongs to the route)', async () => {
    expect(await deleteSubtree(store, 'never/existed', true)).toBeNull();
  });

  it('refuses a non-empty folder without ?recursive=true, and touches nothing (verifier attack 1, part 1)', async () => {
    await uploadFile(store, { path: 'a/b/c.txt', contentType: null, body: utf8('c') });
    await uploadFile(store, { path: 'a/b/d.txt', contentType: null, body: utf8('d') });

    const refused = await deleteSubtree(store, 'a', false);
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'folder_not_empty' } } });

    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(200);
    expect((await downloadFile(store, 'a/b/d.txt')).status).toBe(200);
  });

  it('recursive delete removes every descendant and reports them all (verifier attack 1, part 2)', async () => {
    await uploadFile(store, { path: 'a/b/c.txt', contentType: null, body: utf8('c') });
    await uploadFile(store, { path: 'a/b/d.txt', contentType: null, body: utf8('d') });

    const result = await deleteSubtree(store, 'a', true);
    expect(result).toMatchObject({ status: 200 });
    if (result?.kind !== 'json') throw new Error('expected json');
    const body = result.body as { status: string; deleted: string[] };
    expect(body.status).toBe('ok');
    expect(body.deleted.sort()).toEqual(['a/b/c.txt', 'a/b/d.txt']);

    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(404);
    expect((await downloadFile(store, 'a/b/d.txt')).status).toBe(404);
    const listed = await listFiles(store, null);
    if (listed.kind !== 'json') throw new Error('expected json');
    expect((listed.body as { files: unknown[] }).files).toEqual([]);
  });

  it('an explicit empty folder is deleted without needing ?recursive=true', async () => {
    await createFolder(store, 'empty');
    const result = await deleteSubtree(store, 'empty', false);
    if (result?.kind !== 'json') throw new Error('expected json');
    expect(result.body).toMatchObject({ status: 'ok' });
    expect(await listFiles(store, null)).toMatchObject({ body: { files: [] } });
  });

  it('a failed delete leaves the response as partial, touches nothing outside the subtree, and a retry finishes cleanly', async () => {
    await uploadFile(store, { path: 'a/b/c.txt', contentType: null, body: utf8('c') });
    await uploadFile(store, { path: 'a/b/d.txt', contentType: null, body: utf8('d') });
    await uploadFile(store, { path: 'untouched.txt', contentType: null, body: utf8('safe') });

    const flaky = withOneFailure(store, 'delete', 'a/b/c.txt');
    const first = await deleteSubtree(flaky, 'a', true);
    if (first?.kind !== 'json') throw new Error('expected json');
    expect(first.body).toMatchObject({ status: 'partial', remaining: ['a/b/c.txt'] });
    // The other object in the subtree was deleted; nothing outside it was touched.
    expect((await downloadFile(store, 'a/b/d.txt')).status).toBe(404);
    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(200);
    expect((await downloadFile(store, 'untouched.txt')).status).toBe(200);

    // Retrying the identical request against the real store (no more injected failure) finishes.
    const retried = await deleteSubtree(store, 'a', true);
    if (retried?.kind !== 'json') throw new Error('expected json');
    expect(retried.body).toMatchObject({ status: 'ok', deleted: ['a/b/c.txt'] });
    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(404);
    expect((await downloadFile(store, 'untouched.txt')).status).toBe(200);
  });

  it('refuses a subtree larger than the hard cap rather than deleting it unbounded', async () => {
    await Promise.all(
      Array.from({ length: MAX_SUBTREE_OBJECTS + 1 }, (_, i) =>
        uploadFile(store, { path: `big/${String(i)}.txt`, contentType: null, body: utf8('x') }),
      ),
    );
    const result = await deleteSubtree(store, 'big', true);
    expect(result).toMatchObject({ status: 413, body: { error: { code: 'subtree_too_large' } } });
    // Refused, not partially applied: nothing was deleted.
    expect((await downloadFile(store, 'big/0.txt')).status).toBe(200);
  }, 60_000);
});

describe('moveSubtree', () => {
  it('moves an implied folder and every descendant, preserving relative structure (verifier attack 2, part 1)', async () => {
    await uploadFile(store, { path: 'a/b/c.txt', contentType: 'text/plain', body: utf8('hi') });
    const result = await moveSubtree(store, null, 'a', { newPath: 'z' });
    expect(result).toMatchObject({ status: 200, body: { status: 'ok', moved: 1 } });

    const moved = await downloadFile(store, 'z/b/c.txt');
    if (moved.kind !== 'binary') throw new Error('expected binary');
    expect(Buffer.from(moved.body)).toEqual(Buffer.from(utf8('hi')));
    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(404);
    expect(await listFiles(store, 'a')).toMatchObject({ body: { files: [] } });
  });

  it('moves an explicit empty folder', async () => {
    await createFolder(store, 'a/empty');
    const result = await moveSubtree(store, null, 'a/empty', { newPath: 'moved-empty' });
    expect(result).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(await listFiles(store, null)).toMatchObject({
      body: { files: [{ path: 'moved-empty', kind: 'folder' }] },
    });
  });

  it('refuses moving a folder into its own descendant (verifier attack 2, part 2)', async () => {
    await uploadFile(store, { path: 'a/b/c.txt', contentType: null, body: utf8('x') });
    const result = await moveSubtree(store, null, 'a', { newPath: 'a/b' });
    expect(result).toMatchObject({ status: 409, body: { error: { code: 'self_descendant' } } });
    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(200);
  });

  it('a no-op rename to the identical path succeeds trivially', async () => {
    await uploadFile(store, { path: 'a/b.txt', contentType: null, body: utf8('x') });
    const result = await moveSubtree(store, null, 'a', { newPath: 'a' });
    expect(result).toMatchObject({ status: 200, body: { status: 'ok', moved: 0 } });
    expect((await downloadFile(store, 'a/b.txt')).status).toBe(200);
  });

  it('refuses a destination that already exists', async () => {
    await uploadFile(store, { path: 'a/b.txt', contentType: null, body: utf8('x') });
    await uploadFile(store, { path: 'z/existing.txt', contentType: null, body: utf8('taken') });
    const result = await moveSubtree(store, null, 'a', { newPath: 'z' });
    expect(result).toMatchObject({ status: 409, body: { error: { code: 'name_conflict' } } });
    expect((await downloadFile(store, 'a/b.txt')).status).toBe(200);
    const listed = await listFiles(store, 'z');
    if (listed.kind !== 'json') throw new Error('expected json');
    expect((listed.body as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual([
      'z/existing.txt',
    ]);
  });

  it('refuses a rename that differs only by letter case', async () => {
    await uploadFile(store, { path: 'Docs/readme.txt', contentType: null, body: utf8('x') });
    const result = await moveSubtree(store, null, 'Docs', { newPath: 'docs' });
    expect(result).toMatchObject({ status: 409, body: { error: { code: 'name_conflict' } } });
    expect((await downloadFile(store, 'Docs/readme.txt')).status).toBe(200);
  });

  it('reserves the runner-private directory as both a source and a destination', async () => {
    await uploadFile(store, { path: 'a/b.txt', contentType: null, body: utf8('x') });
    await expect(
      moveSubtree(store, null, 'a', { newPath: '.claude/stolen' }),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'reserved_path' } } });
    await expect(
      moveSubtree(store, null, '.claude', { newPath: 'exfiltrated' }),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'reserved_path' } } });
  });

  it('a folder that does not exist is 404', async () => {
    const result = await moveSubtree(store, null, 'nope', { newPath: 'also-nope' });
    expect(result).toMatchObject({ status: 404 });
  });

  it('a failed copy is reported as partial and leaves the source subtree untouched', async () => {
    await uploadFile(store, { path: 'a/b/c.txt', contentType: null, body: utf8('c') });
    await uploadFile(store, { path: 'a/b/d.txt', contentType: null, body: utf8('d') });
    const flaky = withOneFailure(store, 'copyObject', 'a/b/d.txt');

    const first = await moveSubtree(flaky, null, 'a', { newPath: 'z' });
    expect(first).toMatchObject({ status: 200, body: { status: 'partial' } });
    // Nothing was deleted from the source — a partial copy phase never reaches the delete phase.
    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(200);
    expect((await downloadFile(store, 'a/b/d.txt')).status).toBe(200);

    const retried = await moveSubtree(store, null, 'a', { newPath: 'z' });
    expect(retried).toMatchObject({ status: 200, body: { status: 'ok', moved: 2 } });
    expect((await downloadFile(store, 'z/b/c.txt')).status).toBe(200);
    expect((await downloadFile(store, 'z/b/d.txt')).status).toBe(200);
    expect((await downloadFile(store, 'a/b/c.txt')).status).toBe(404);
  });

  it('refuses a subtree larger than the hard cap rather than moving it unbounded', async () => {
    await Promise.all(
      Array.from({ length: MAX_SUBTREE_OBJECTS + 1 }, (_, i) =>
        uploadFile(store, { path: `big/${String(i)}.txt`, contentType: null, body: utf8('x') }),
      ),
    );
    const result = await moveSubtree(store, null, 'big', { newPath: 'elsewhere' });
    expect(result).toMatchObject({ status: 413, body: { error: { code: 'subtree_too_large' } } });
    expect((await downloadFile(store, 'big/0.txt')).status).toBe(200);
  }, 60_000);
});
