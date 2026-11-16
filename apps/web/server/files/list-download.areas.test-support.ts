import { expect, it } from 'vitest';
import { POST as uploadRoute } from '../../app/api/files/route';
import { DELETE as deleteRoute, PATCH as renameRoute } from '../../app/api/files/[id]/route';
import { bytesToStream } from '@agent-workspace/core/storage';
import { encodeFileId } from './file-id';
import type { FileReadFixture } from './list-download.harness.test-support';
import { ACTOR_HEADER, bytesOf } from './list-download.fixture.test-support';
export function registerFileReadAreasTests(
  getFixture: () => Pick<
    FileReadFixture,
    'storage' | 'ctxOf' | 'world' | 'save' | 'listed' | 'download'
  >,
) {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] the files API hides skill rows by area and keeps a user file under .skills/', async () => {
    const testContext = getFixture();

    const saved = await testContext.storage.save(testContext.ctxOf(testContext.world.a), {
      area: 'skills',
      path: '.skills/demo/SKILL.md',
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(bytesOf('# demo')),
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    // A file a user saved under `.skills/` before the root was reserved.
    await testContext.save('.skills/notes.txt', 'notes');
    await testContext.save('docs/a.txt', 'a');
    const skill = '.skills/demo/SKILL.md';
    const headers = { [ACTOR_HEADER]: 'a', 'content-type': 'application/json' };
    const idRequest = (path: string, method: string, body?: unknown, query = '') =>
      [
        new Request(`https://example.invalid/api/files/${encodeFileId(path)}${query}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        { params: Promise.resolve({ id: encodeFileId(path) }) },
      ] as const;

    expect((await testContext.listed('a')).map((entry) => entry.path)).toEqual(['.skills', 'docs']);
    expect((await testContext.listed('a', '.skills')).map((entry) => entry.path)).toEqual([
      '.skills/notes.txt',
    ]);
    expect((await testContext.listed('a', '.skills/demo')).map((entry) => entry.path)).toEqual([]);
    const notes = await testContext.download('a', '.skills/notes.txt');
    expect(notes.status).toBe(200);
    expect(await notes.text()).toBe('notes');
    expect((await testContext.download('a', skill)).status).toBe(404);

    // A skill row moves only through /api/skills: neither it nor a folder holding it moves here.
    expect((await renameRoute(...idRequest(skill, 'PATCH', { newPath: 'moved.md' }))).status).toBe(
      400,
    );
    expect(
      (await renameRoute(...idRequest('.skills/demo', 'PATCH', { newPath: 'demo' }))).status,
    ).toBe(400);
    expect(
      (await deleteRoute(...idRequest('.skills', 'DELETE', undefined, '?recursive=true'))).status,
    ).toBe(400);
    expect((await deleteRoute(...idRequest(skill, 'DELETE'))).status).toBe(204);

    // No new path under `.skills/`: not by upload, not by rename into it.
    const upload = await uploadRoute(
      new Request('https://example.invalid/api/files', {
        method: 'POST',
        headers: { [ACTOR_HEADER]: 'a', 'x-file-path': '.skills/new.txt' },
        body: 'new',
      }),
    );
    expect(upload.status).toBe(400);
    expect(
      (await renameRoute(...idRequest('docs/a.txt', 'PATCH', { newPath: '.skills/demo/x.md' })))
        .status,
    ).toBe(400);
    expect(
      (
        await testContext.storage.list(
          testContext.ctxOf(testContext.world.a),
          'skills',
          '.skills/demo',
        )
      ).rows,
    ).toHaveLength(1);

    // The user's own file renames out, and deletes.
    expect(
      (await renameRoute(...idRequest('.skills/notes.txt', 'PATCH', { newPath: 'notes.txt' })))
        .status,
    ).toBe(200);
    expect(await (await testContext.download('a', 'notes.txt')).text()).toBe('notes');
    expect((await deleteRoute(...idRequest('notes.txt', 'DELETE'))).status).toBe(204);
    expect((await testContext.download('a', 'notes.txt')).status).toBe(404);
  });
}
