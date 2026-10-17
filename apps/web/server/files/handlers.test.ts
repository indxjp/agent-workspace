/**
 * `handlers.ts` against a real {@link ObjectStore} — the local-filesystem one, through
 * `object-store-bridge.ts` — so this suite exercises the same code path production will, not a
 * hand-rolled fake that could silently drift from what `packages/core/src/storage` actually does.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encodeFileId } from './file-id';
import {
  deleteFile,
  downloadFile,
  createFolder,
  listFiles,
  renameFile,
  requireFilePath,
  uploadFile,
} from './handlers';
import { createLocalFilesystemObjectStoreProvider, type ObjectStore } from './object-store-bridge';

const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';

let rootDir: string;
let store: ObjectStore;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-handlers-'));
  store = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('uploadFile / downloadFile / deleteFile', () => {
  it('uploads a file and returns its resource with an id that decodes back to the path', async () => {
    const result = await uploadFile(store, {
      path: 'instructions.md',
      contentType: 'text/markdown',
      body: utf8('# hello'),
    });
    expect(result.status).toBe(201);
    expect(result.kind).toBe('json');
    if (result.kind !== 'json') throw new Error('expected json');
    const body = result.body as { file: { id: string; path: string; contentType: string } };
    expect(body.file.path).toBe('instructions.md');
    expect(body.file.contentType).toBe('text/markdown');

    const parsed = requireFilePath(body.file.id);
    expect(parsed).toEqual({ ok: true, path: 'instructions.md' });
  });

  it('downloads exactly the bytes that were uploaded, trailing newline included', async () => {
    await uploadFile(store, { path: 'with-nl.txt', contentType: 'text/plain', body: utf8('a\n') });
    await uploadFile(store, { path: 'without-nl.txt', contentType: 'text/plain', body: utf8('a') });

    const withNl = await downloadFile(store, 'with-nl.txt');
    const withoutNl = await downloadFile(store, 'without-nl.txt');
    if (withNl.kind !== 'binary' || withoutNl.kind !== 'binary') throw new Error('expected binary');
    expect(Buffer.from(withNl.body)).toEqual(Buffer.from(utf8('a\n')));
    expect(Buffer.from(withoutNl.body)).toEqual(Buffer.from(utf8('a')));
  });

  it('downloading a file that was never uploaded is 404', async () => {
    const result = await downloadFile(store, 'nope.txt');
    expect(result.status).toBe(404);
  });

  it('rejects an upload path that would escape the workspace, before anything is written', async () => {
    const result = await uploadFile(store, {
      path: '../escape.txt',
      contentType: null,
      body: utf8('x'),
    });
    expect(result.status).toBe(400);
    expect(await downloadFile(store, 'escape.txt')).toMatchObject({ status: 404 });
  });

  it('reserves the runner private directory regardless of path casing', async () => {
    const upload = await uploadFile(store, {
      path: '.ClAuDe/settings.json',
      contentType: 'application/json',
      body: utf8('{}'),
    });
    expect(upload).toMatchObject({ status: 400, body: { error: { code: 'reserved_path' } } });
    await uploadFile(store, { path: 'safe.txt', contentType: null, body: utf8('safe') });
    await expect(
      renameFile(store, 'safe.txt', { newPath: '.CLAUDE/settings.json' }),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'reserved_path' } } });
    await expect(createFolder(store, '.cLaUdE/cache')).resolves.toMatchObject({
      status: 400,
      body: { error: { code: 'reserved_path' } },
    });
  });

  it('does not upload a file onto an existing explicit folder', async () => {
    await createFolder(store, 'reports');
    await expect(
      uploadFile(store, { path: 'reports', contentType: null, body: utf8('file') }),
    ).resolves.toMatchObject({ status: 409, body: { error: { code: 'name_conflict' } } });
    expect(await listFiles(store, null)).toMatchObject({
      body: { files: [{ path: 'reports', kind: 'folder' }] },
    });
  });

  it('delete removes the file, and deleting twice is not an error', async () => {
    await uploadFile(store, { path: 'gone.txt', contentType: null, body: utf8('bye') });
    expect((await deleteFile(store, 'gone.txt')).status).toBe(204);
    expect((await downloadFile(store, 'gone.txt')).status).toBe(404);
    expect((await deleteFile(store, 'gone.txt')).status).toBe(204);
  });
});

describe('listFiles', () => {
  it('creates and lists an explicit empty folder without exposing its storage marker', async () => {
    const created = await createFolder(store, 'empty/reports');
    expect(created.status).toBe(201);
    const root = await listFiles(store, 'empty');
    expect(root).toMatchObject({
      status: 200,
      body: { files: [{ path: 'empty/reports', kind: 'folder' }] },
    });
    const inside = await listFiles(store, 'empty/reports');
    expect(inside).toMatchObject({ status: 200, body: { files: [] } });
    await deleteFile(store, 'empty/reports');
    const afterDelete = await listFiles(store, 'empty');
    expect(afterDelete).toMatchObject({ status: 200, body: { files: [] } });
  });

  it('does not create a folder at an existing file path', async () => {
    await uploadFile(store, { path: 'reports', contentType: null, body: utf8('file') });
    await expect(createFolder(store, 'reports')).resolves.toMatchObject({
      status: 409,
      body: { error: { code: 'name_conflict' } },
    });
    expect(await downloadFile(store, 'reports')).toMatchObject({ status: 200, kind: 'binary' });
  });

  it('reports uploaded files and implied folders one level under a prefix', async () => {
    await uploadFile(store, {
      path: 'contracts/agreement.pdf',
      contentType: null,
      body: utf8('x'),
    });
    await uploadFile(store, { path: 'instructions.md', contentType: null, body: utf8('# hi') });

    const root = await listFiles(store, null);
    if (root.kind !== 'json') throw new Error('expected json');
    const files = (root.body as { files: Array<{ kind: string; path: string }> }).files;
    const paths = files.map((f) => `${f.kind}:${f.path}`).sort();
    expect(paths).toEqual(['file:instructions.md', 'folder:contracts']);
  });

  it('rejects a traversal attempt given as the "path" query value', async () => {
    const result = await listFiles(store, '../../etc');
    expect(result.status).toBe(400);
  });
});

describe('renameFile', () => {
  it('moves a file to a new path and the old path is gone', async () => {
    await uploadFile(store, { path: 'old.txt', contentType: 'text/plain', body: utf8('content') });
    const renamed = await renameFile(store, 'old.txt', { newPath: 'renamed/new.txt' });
    expect(renamed.status).toBe(200);
    expect((await downloadFile(store, 'old.txt')).status).toBe(404);
    const moved = await downloadFile(store, 'renamed/new.txt');
    if (moved.kind !== 'binary') throw new Error('expected binary');
    expect(Buffer.from(moved.body)).toEqual(Buffer.from(utf8('content')));
  });

  it('refuses to rename onto an existing file', async () => {
    await uploadFile(store, { path: 'a.txt', contentType: null, body: utf8('a') });
    await uploadFile(store, { path: 'b.txt', contentType: null, body: utf8('b') });
    const result = await renameFile(store, 'a.txt', { newPath: 'b.txt' });
    expect(result.status).toBe(409);
    // Neither file was disturbed by the refused rename.
    const a = await downloadFile(store, 'a.txt');
    const b = await downloadFile(store, 'b.txt');
    if (a.kind !== 'binary' || b.kind !== 'binary') throw new Error('expected binary');
    expect(Buffer.from(a.body)).toEqual(Buffer.from(utf8('a')));
    expect(Buffer.from(b.body)).toEqual(Buffer.from(utf8('b')));
  });

  it('refuses to rename onto a folder or the private empty-folder marker', async () => {
    await uploadFile(store, { path: 'a.txt', contentType: null, body: utf8('a') });
    await createFolder(store, 'reports');
    await expect(renameFile(store, 'a.txt', { newPath: 'reports' })).resolves.toMatchObject({
      status: 409,
      body: { error: { code: 'name_conflict' } },
    });
    await expect(
      renameFile(store, 'a.txt', { newPath: 'reports/.agent-workspace-empty-folder' }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: 'reserved_path' } },
    });
    expect(await downloadFile(store, 'a.txt')).toMatchObject({ status: 200, kind: 'binary' });
  });

  it('rejects a rename target that would escape the workspace', async () => {
    await uploadFile(store, { path: 'a.txt', contentType: null, body: utf8('a') });
    const result = await renameFile(store, 'a.txt', { newPath: '../../etc/passwd' });
    expect(result.status).toBe(400);
    expect((await downloadFile(store, 'a.txt')).status).toBe(200);
  });

  it('renaming a file that does not exist is 404', async () => {
    const result = await renameFile(store, 'nope.txt', { newPath: 'x.txt' });
    expect(result.status).toBe(404);
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
