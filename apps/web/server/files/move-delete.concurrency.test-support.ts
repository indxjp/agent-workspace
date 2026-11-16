import { listCatalogFiles } from '@agent-workspace/core/db';
import { expect, it } from 'vitest';
import { POST as uploadRoute } from '../../app/api/files/route';
import { ACTOR_HEADER, createMoveDeleteFixture } from './move-delete.test-support';

export function registerConcurrencyTests(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  // @story US-STO-03
  it('[US-STO-03][api][sdk] two concurrent renames onto one destination: one 200, one 409, both files still download', () =>
    fixture.expectRenameRacesSettle(fixture.save));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] a rename racing an upload to its destination: the upload lands, the rename lands first or answers 409, nothing is lost', async () => {
    for (const folder of fixture.raceFolders) await fixture.save(`${folder}/a.txt`, 'alpha');

    const responses = await Promise.all(
      fixture.raceFolders.map((folder) =>
        Promise.all([
          fixture.move(`${folder}/a.txt`, `${folder}/x.txt`),
          uploadRoute(
            new Request('https://example.invalid/api/files', {
              method: 'POST',
              body: 'uploaded',
              headers: { [ACTOR_HEADER]: 'owner', 'x-file-path': `${folder}/x.txt` },
            }),
          ),
        ]),
      ),
    );

    const expectedPaths: string[] = [];
    for (const [at, folder] of fixture.raceFolders.entries()) {
      const [renamed, uploaded] = responses[at] ?? [];
      if (renamed === undefined || uploaded === undefined) throw new Error('a request is missing');
      // An upload replaces a ready file, so a rename that commits first is then replaced; one
      // that comes second meets the upload's row and refuses.
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
      expect([200, 409]).toContain(renamed.status);
      if (renamed.status === 409) {
        const { error } = (await renamed.json()) as { error: { code: string } };
        expect(['name_conflict', 'upload_in_progress']).toContain(error.code);
      }
      expect(await (await fixture.download(`${folder}/x.txt`)).text()).toBe('uploaded');
      const source = await fixture.download(`${folder}/a.txt`);
      if (renamed.status === 200) {
        expect(source.status).toBe(404);
      } else {
        expect(await source.text()).toBe('alpha');
        expectedPaths.push(`${folder}/a.txt`);
      }
      expectedPaths.push(`${folder}/x.txt`);
    }
    const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);
    expect(await catalog.countPending()).toBe(0);
    const rows = (await listCatalogFiles(catalog)).filter((row) => row.kind === 'file');
    expect(rows.map((row) => row.path).sort()).toEqual(expectedPaths.sort());
  });
}
