import { expect, it } from 'vitest';
import { EXTRACT_MAX_FILE_BYTES } from './extract';
import { bytesOf, createFileSearchFixture, saveClaimedRow } from './file-search.test-support';

export function registerCatalogTests(fixture: ReturnType<typeof createFileSearchFixture>) {
  // @story US-STO-01
  it('[US-STO-01][api][sdk] search finds a file saved under the new naming', async () => {
    const row = await fixture.save('reports/q3.txt', 'quarter zebracorn');
    expect(row.objectId).not.toBeNull();

    expect(await fixture.hitPaths('a', 'zebracorn')).toEqual(['reports/q3.txt']);
    expect(await fixture.hitPaths('b', 'zebracorn')).toEqual([]);
    expect(await fixture.downloadStatus('b', 'reports/q3.txt')).toBe(404);
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] search finds Japanese text by a word inside it, and a Japanese word it lacks finds nothing', async () => {
    await fixture.save('manuals/pump.txt', '保守手順書 第3章');

    expect(await fixture.hitPaths('a', encodeURIComponent('手順'))).toEqual(['manuals/pump.txt']);
    expect(await fixture.hitPaths('a', encodeURIComponent('第3章'))).toEqual(['manuals/pump.txt']);
    expect(await fixture.hitPaths('a', encodeURIComponent('点検ガイド'))).toEqual([]);
    expect(await fixture.hitPaths('b', encodeURIComponent('手順'))).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] search skips a skill row but finds a user file under .skills/', async () => {
    await fixture.save('.skills/demo/SKILL.md', 'skill zebracorn', 'skills');
    await fixture.save('.skills/notes.txt', 'notes zebracorn');

    expect(await fixture.hitPaths('a', 'zebracorn')).toEqual(['.skills/notes.txt']);
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] search does not find a pending upload', async () => {
    const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);
    await catalog.reserve('docs/pending.txt', {
      ownerPrincipalId: fixture.world.a.principalId,
      sizeBytes: 12,
      contentType: 'text/plain',
      objectId: crypto.randomUUID(),
      area: 'files',
    });

    expect(await fixture.hitPaths('a', 'zebracorn')).toEqual([]);
    expect(await fixture.downloadStatus('a', 'docs/pending.txt')).toBe(404);
    expect(await fixture.downloadStatus('b', 'docs/pending.txt')).toBe(404);
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] search reads no more than the extraction cap of an object', async () => {
    // The row claims a small size; the object is larger than the cap and holds the word at its start.
    const oversized = new Uint8Array(EXTRACT_MAX_FILE_BYTES + 1).fill(0x20);
    oversized.set(bytesOf('zebracorn'));
    await saveClaimedRow(fixture.world, fixture.objects, {
      path: 'big/claimed-small.txt',
      body: oversized,
      claimedSize: 9,
    });
    await fixture.save('big/honest.txt', 'zebracorn');

    expect(await fixture.hitPaths('a', 'zebracorn')).toEqual(['big/honest.txt']);
    expect(await fixture.hitPaths('b', 'zebracorn')).toEqual([]);
    expect(await fixture.downloadStatus('b', 'big/honest.txt')).toBe(404);
  });
}
