import { expect, it } from 'vitest';

import { storageObjectName } from '@agent-workspace/core/storage';
import { readWhole } from '@agent-workspace/core/storage/streams';
import { FileResourceSchema, MAX_UPLOAD_BYTES } from '@indx-workspace/contracts/files';
import { generatedBody } from '../../../../tests/load/flat-memory';
import type { FileUploadFixture } from './upload-route.harness.test-support';
import { bytesOf, sha256Of } from './upload-route.fixture.test-support';
export function registerFileUploadSavingTests(
  getFixture: () => Pick<
    FileUploadFixture,
    'post' | 'catalogA' | 'world' | 'objects' | 'legacy' | 'filesObjects'
  >,
) {
  // @story US-STO-01
  it('[US-STO-01][api][sdk] an uploaded file has a ready row with its SHA-256 and lives under workspaces/<ws>/files/<objectId>', async () => {
    const testContext = getFixture();

    const bytes = bytesOf('quarter three');
    const response = await testContext.post('reports/q3.pdf', bytes);
    expect(response.status, await response.clone().text()).toBe(201);
    const { file } = (await response.json()) as { file: unknown };
    expect(FileResourceSchema.parse(file)).toMatchObject({
      path: 'reports/q3.pdf',
      kind: 'file',
      sizeBytes: bytes.byteLength,
    });

    const row = await (await testContext.catalogA()).get('reports/q3.pdf');
    expect(row).toMatchObject({ status: 'ready', sha256: sha256Of(bytes) });
    expect((file as { id: string }).id).toBe(row?.id);
    const objectId = row?.objectId ?? null;
    if (objectId === null) throw new Error('the row has no object id');
    const stored = storageObjectName(testContext.world.a.workspaceId, 'files', objectId);
    expect(await testContext.objects.head(stored)).not.toBeNull();
    expect(
      await readWhole(
        testContext.legacy.forWorkspace(testContext.world.a.workspaceId),
        'reports/q3.pdf',
      ),
    ).toBeNull();

    const refused = await testContext.post('reports/other.pdf', bytes, 'v');
    expect(refused.status).toBe(403);
    expect(
      await (await testContext.catalogA()).get('reports/other.pdf', { includePending: true }),
    ).toBeNull();
    expect(await testContext.filesObjects()).toEqual([stored]);
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] an uploaded file keeps the request Content-Type, or its name gives one', async () => {
    const testContext1 = getFixture();

    const typed = await testContext1.post('data/export.bin', bytesOf('a,b\n'), 'a', {
      'content-type': 'text/csv; charset=utf-8',
    });
    expect(typed.status, await typed.clone().text()).toBe(201);
    expect(await typed.json()).toMatchObject({
      file: { contentType: 'text/csv; charset=utf-8' },
    });
    const catalog = await testContext1.catalogA();
    expect(await catalog.get('data/export.bin')).toMatchObject({
      contentType: 'text/csv; charset=utf-8',
    });

    const named = await testContext1.post('data/notes.md', bytesOf('# notes'), 'a', {
      'content-type': '   ',
    });
    expect(named.status).toBe(201);
    expect(await catalog.get('data/notes.md')).toMatchObject({ contentType: 'text/markdown' });
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] a body over MAX_UPLOAD_BYTES with no Content-Length is 413 and the previous version stays', async () => {
    const testContext2 = getFixture();

    const first = bytesOf('first version');
    expect((await testContext2.post('big.bin', first)).status).toBe(201);
    const before = await (await testContext2.catalogA()).get('big.bin');
    const objectsBefore = await testContext2.filesObjects();

    const response = await testContext2.post('big.bin', generatedBody(MAX_UPLOAD_BYTES + 1).body);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'request_body_too_large' } });

    const after = await (await testContext2.catalogA()).get('big.bin');
    expect(after).toMatchObject({
      id: before?.id,
      objectId: before?.objectId,
      sha256: sha256Of(first),
    });
    expect(await testContext2.filesObjects()).toEqual(objectsBefore);
    expect(
      await (await testContext2.catalogA()).get('big.bin', { includePending: true }),
    ).toMatchObject({
      status: 'ready',
    });

    const declared = await testContext2.post('big.bin', first, 'a', {
      'content-length': String(MAX_UPLOAD_BYTES + 1),
    });
    expect(declared.status).toBe(413);
    expect((await testContext2.post('big.bin', first, 'v')).status).toBe(403);
    expect(await testContext2.filesObjects()).toEqual(objectsBefore);
  }, 120_000);
}
