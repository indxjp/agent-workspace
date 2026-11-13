import { expect, it, vi } from 'vitest';
import { FileResourceSchema } from '@indx-workspace/contracts/files';
import type { FileUploadFixture } from './upload-route.harness.test-support';
import { heldBody, bytesOf, sha256Of } from './upload-route.fixture.test-support';
export function registerFileUploadConcurrencyTests(
  getFixture: () => Pick<
    FileUploadFixture,
    'post' | 'catalogA' | 'filesObjects' | 'postFolder' | 'listed'
  >,
) {
  // @story US-STO-14
  it('[US-STO-14][api][sdk] a second upload to a path being uploaded is 409 for the same member and another; the first still lands', async () => {
    const testContext = getFixture();

    const held = heldBody(bytesOf('first '));
    const winner = testContext.post('race.txt', held.body);
    await vi.waitFor(async () =>
      expect(
        await (await testContext.catalogA()).get('race.txt', { includePending: true }),
      ).toMatchObject({
        status: 'pending',
      }),
    );

    for (const actor of ['a', 'c'] as const) {
      const loser = await testContext.post('race.txt', bytesOf('second'), actor);
      expect(loser.status).toBe(409);
      expect(await loser.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
    }
    expect((await testContext.post('race.txt', bytesOf('second'), 'v')).status).toBe(403);

    held.finish(bytesOf('done'));
    const response = await winner;
    expect(response.status).toBe(201);
    expect(await (await testContext.catalogA()).get('race.txt')).toMatchObject({
      status: 'ready',
      sha256: sha256Of(bytesOf('first done')),
    });
    expect(await testContext.filesObjects()).toHaveLength(1);
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] a folder is a catalog row with no marker object, listed by GET, and a second create is 409', async () => {
    const testContext1 = getFixture();

    const response = await testContext1.postFolder('docs/specs');
    expect(response.status, await response.clone().text()).toBe(201);
    expect(
      FileResourceSchema.parse(((await response.json()) as { file: unknown }).file),
    ).toMatchObject({ path: 'docs/specs', kind: 'folder' });
    expect(await (await testContext1.catalogA()).get('docs/specs')).toMatchObject({
      kind: 'folder',
      status: 'ready',
    });
    expect(await testContext1.filesObjects()).toEqual([]);
    expect((await testContext1.listed('docs')).map((file) => file.path)).toEqual(['docs/specs']);

    const again = await testContext1.postFolder('docs/specs');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'name_conflict' } });

    const onFolder = await testContext1.post('docs/specs', bytesOf('x'));
    expect(onFolder.status).toBe(409);
    expect(await onFolder.json()).toMatchObject({ error: { code: 'name_conflict' } });
    expect(await (await testContext1.catalogA()).get('docs/specs')).toMatchObject({
      kind: 'folder',
    });
    expect(await testContext1.filesObjects()).toEqual([]);

    expect((await testContext1.post('docs/file.txt', bytesOf('x'))).status).toBe(201);
    expect((await testContext1.postFolder('docs/file.txt')).status).toBe(409);
    expect((await testContext1.postFolder('docs/other', 'v')).status).toBe(403);
    expect(await (await testContext1.catalogA()).get('docs/other')).toBeNull();
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] a folder over a path being uploaded is 409 upload_in_progress', async () => {
    const testContext2 = getFixture();

    const held = heldBody(bytesOf('x'));
    const upload = testContext2.post('busy', held.body);
    await vi.waitFor(async () =>
      expect(
        await (await testContext2.catalogA()).get('busy', { includePending: true }),
      ).not.toBeNull(),
    );

    const folder = await testContext2.postFolder('busy');
    expect(folder.status).toBe(409);
    expect(await folder.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
    expect((await testContext2.postFolder('busy', 'v')).status).toBe(403);

    held.finish(bytesOf('y'));
    expect((await upload).status).toBe(201);
  });
}
