/**
 * SDK conformance, files: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileListResponseSchema,
  FileResponseSchema,
  fileRouteId,
  FILES_PROBLEM_CODES,
  MAX_UPLOAD_BYTES,
  MoveFileResponseSchema,
  PresignedUrlSchema,
  SubtreeDeleteOutcomeSchema,
} from '@indx-workspace/contracts/files';
import { encodeFileId } from './files/file-id';
import { requireFilePath } from './files/handlers';
import { boundedBodyStream, toResponse } from './files/http';
import {
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { POST as downloadUrlsRoute } from '../app/api/files/[id]/download-urls/route';
import { POST as uploadUrlsRoute } from '../app/api/files/[id]/upload-urls/route';
import { clearApplicationContext } from './application-context';
import {
  FILES_WORKSPACE,
  utf8,
  currentWorld,
  install,
  upload,
  folder,
  list,
  download,
  rename,
  remove,
  mint,
  complete,
  problemOf,
} from './sdk-conformance.files.test-support';

describe('files', () => {
  beforeEach(() => {
    install();
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('mints the same route id for a path as the server does', () => {
    for (const filePath of [
      'a/b c.txt',
      'contracts/agreement.pdf',
      '案件/見積書_日本語.txt',
      'x',
    ]) {
      expect(fileRouteId(filePath)).toBe(encodeFileId(filePath));
      expect(requireFilePath(fileRouteId(filePath))).toEqual({ ok: true, path: filePath });
    }
  });

  it('renders uploads, folders, listings and renames into the published shapes', async () => {
    const uploaded = await upload('reports/q3 summary.md', '# Q3', 'text/markdown');
    expect(uploaded.status).toBe(201);
    expect(FileResponseSchema.safeParse(await uploaded.json()).success).toBe(true);

    const created = await folder('empty');
    expect(created.status).toBe(201);
    const createdFolder = FileResponseSchema.parse(await created.json()).file;
    expect(createdFolder).toMatchObject({ kind: 'folder', sizeBytes: null, lastModified: null });

    await upload('raw.bin', 'x');
    const listed = await list(null);
    expect(listed.status).toBe(200);
    const listing = FileListResponseSchema.parse(await listed.json());
    expect(listing.files.map((file) => [file.path, file.kind])).toEqual([
      ['empty', 'folder'],
      ['raw.bin', 'file'],
      ['reports', 'folder'],
    ]);
    expect(FileListResponseSchema.safeParse(await (await list('reports')).json()).success).toBe(
      true,
    );

    const asFolder = await download('reports');
    expect(asFolder.status).toBe(200);
    expect(FileResponseSchema.safeParse(await asFolder.json()).success).toBe(true);

    const renamed = await rename('raw.bin', 'renamed.bin');
    expect(renamed.status).toBe(200);
    const renamedBody: unknown = await renamed.json();
    expect(MoveFileResponseSchema.safeParse(renamedBody).success).toBe(true);
    expect(FileResponseSchema.parse(renamedBody).file.path).toBe('renamed.bin');
  });
});

/** An in-memory object store that claims it can sign, answering a URL that records the ttl. */
function signingObjectStore(): ObjectStore {
  const plain = createInMemoryObjectStore();
  return {
    ...plain,
    capabilities: { ...plain.capabilities, sign: true },
    createSignedUrl: (key, request) =>
      Promise.resolve({
        url: `https://store.example/${key}?ttl=${String(request.expiresInSeconds)}`,
        headers: request.contentType === undefined ? {} : { 'content-type': 'text/plain' },
      }),
  };
}

async function expectPresignedLinksMinted(): Promise<void> {
  const up = await mint(uploadUrlsRoute, 'upload-urls', 'new.txt', {
    contentType: 'text/plain',
    sizeBytes: 3,
    ttlSeconds: 120,
  });
  expect(up.status).toBe(201);
  expect(PresignedUrlSchema.parse(await up.json())).toMatchObject({
    method: 'PUT',
    path: 'new.txt',
  });

  const down = await mint(downloadUrlsRoute, 'download-urls', 'doc.txt', { ttlSeconds: 120 });
  expect(down.status).toBe(201);
  expect(PresignedUrlSchema.parse(await down.json())).toMatchObject({
    method: 'GET',
    path: 'doc.txt',
  });
}

/** The step the SDK runs after the PUT: complete answers the published `{ file }`, or 409. */
async function expectUploadCompletion(): Promise<void> {
  const pending = await (
    await currentWorld().catalogs.forWorkspace(FILES_WORKSPACE)
  ).pending('new.txt');
  if (pending?.objectId === null || pending?.objectId === undefined) {
    throw new Error('minting an upload link must leave a pending row');
  }
  await currentWorld().objects.write(
    storageObjectName(FILES_WORKSPACE, 'files', pending.objectId),
    utf8('abc'),
    { contentType: 'text/plain' },
  );
  const completed = await complete('new.txt');
  expect(completed.status).toBe(200);
  expect(FileResponseSchema.parse(await completed.json()).file).toMatchObject({
    path: 'new.txt',
    sizeBytes: 3,
  });
  await mint(uploadUrlsRoute, 'upload-urls', 'never-put.txt', { sizeBytes: 3 });
  expect(await problemOf(await complete('never-put.txt'))).toEqual({
    status: 409,
    code: 'upload_not_verified',
  });
  expect(FILES_PROBLEM_CODES.upload_not_verified).toBe(409);
}

async function expectUnsignedStoreRefusesLinks(): Promise<void> {
  for (const refused of [
    await mint(uploadUrlsRoute, 'upload-urls', 'new.txt', { sizeBytes: 3, ttlSeconds: 120 }),
    await mint(downloadUrlsRoute, 'download-urls', 'doc.txt', { ttlSeconds: 120 }),
  ]) {
    expect(await problemOf(refused)).toEqual({
      status: 501,
      code: 'direct_transfer_unsupported',
    });
  }
  expect(FILES_PROBLEM_CODES.direct_transfer_unsupported).toBe(501);
}

describe('files', () => {
  beforeEach(() => {
    install();
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('serves a download as an inert attachment with the two-form filename the SDK parses', async () => {
    await upload('案件/見積 書.txt', 'hi', 'text/plain');
    const response = await download('案件/見積 書.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="____.txt"; filename*=UTF-8''${encodeURIComponent('見積 書.txt')}`,
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('hi');
  });

  it('renders every subtree outcome into the published unions', async () => {
    await upload('tree/one.txt', '1');
    await upload('tree/deep/two.txt', '2');

    const moved = await rename('tree', 'moved');
    expect(moved.status).toBe(200);
    const movedBody = (await moved.json()) as { status: string; moved: number };
    expect(MoveFileResponseSchema.safeParse(movedBody).success).toBe(true);
    expect(movedBody.status).toBe('ok');
    expect(movedBody.moved).toBeGreaterThanOrEqual(2);

    const refused = await remove('moved', false);
    expect(await problemOf(refused)).toEqual({ status: 409, code: 'folder_not_empty' });

    const deleted = await remove('moved', true);
    expect(deleted.status).toBe(200);
    expect(SubtreeDeleteOutcomeSchema.safeParse(await deleted.json()).success).toBe(true);
    expect((await remove('moved', true)).status).toBe(204);
  });
});

describe('files', () => {
  beforeEach(() => {
    install();
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('answers each documented refusal with a code and status the contract publishes', async () => {
    await upload('file.txt', 'x');
    await folder('dir');
    const refusals = [
      await list('../outside'),
      await folder('.claude/cache'),
      await upload('dir', 'x'),
      await folder('file.txt'),
      await rename('missing.txt', 'x.txt'),
      await rename('dir', 'dir/inner'),
      await rename('nowhere', 'somewhere'),
    ];
    const seen = await Promise.all(refusals.map(problemOf));
    expect(seen).toEqual([
      { status: 400, code: 'invalid_path' },
      { status: 400, code: 'reserved_path' },
      { status: 409, code: 'name_conflict' },
      { status: 409, code: 'name_conflict' },
      { status: 404, code: 'file_not_found' },
      { status: 409, code: 'self_descendant' },
      { status: 404, code: 'file_not_found' },
    ]);
    for (const { status, code } of seen) {
      expect(FILES_PROBLEM_CODES[code as keyof typeof FILES_PROBLEM_CODES]).toBe(status);
    }
    const unminted = requireFilePath('not base64url!');
    expect(unminted.ok ? null : await problemOf(toResponse(unminted.result))).toEqual({
      status: 404,
      code: 'file_not_found',
    });
  });
});

describe('files', () => {
  beforeEach(() => {
    install();
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('renders presigned URLs into the published shape, or 501 when the store cannot sign', async () => {
    install(signingObjectStore());
    await upload('doc.txt', 'x', 'text/plain');
    await expectPresignedLinksMinted();
    await expectUploadCompletion();

    install();
    await upload('doc.txt', 'x', 'text/plain');
    await expectUnsignedStoreRefusesLinks();
  });
});

describe('files', () => {
  beforeEach(() => {
    install();
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('bounds uploads at the contract limit', () => {
    const oversized = new Request('http://localhost/api/files', {
      method: 'POST',
      headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
    });
    const bounded = boundedBodyStream(oversized);
    expect(bounded).toMatchObject({ ok: false, result: { status: 413 } });
    const atLimit = boundedBodyStream(
      new Request('http://localhost/api/files', {
        method: 'POST',
        headers: { 'content-length': String(MAX_UPLOAD_BYTES) },
      }),
    );
    expect(atLimit.ok).toBe(true);
  });
});
