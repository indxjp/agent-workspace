import { expect } from 'vitest';

import { storageObjectName } from '@agent-workspace/core/storage';

import {
  bytesOf,
  defineAuditSuites,
  eventOf,
  link,
  mintRequest,
  saveInput,
  useIsolatedAuditDatabase,
  type AuditHarness,
} from './audit.test-support';

const database = useIsolatedAuditDatabase();

async function uploadIsAudited(h: AuditHarness) {
  const relayed = await h.save('a.txt', 'abc');
  expect(h.events).toEqual([
    eventOf(h, { action: 'file-uploaded', subjectId: relayed.id, subjectLabel: 'a.txt' }),
  ]);

  // A signed link: the mint is a link, the complete is the upload.
  h.events.length = 0;
  expect((await h.storage.reserveUpload(h.ctx, mintRequest('b.txt'))).ok).toBe(true);
  const pending = await h.catalog.pending('b.txt');
  if (pending === null) throw new Error('no pending row');
  const name = storageObjectName(h.ws.id, 'files', pending.objectId ?? '');
  await h.objects.write(name, bytesOf('xyz'), { contentType: null });
  const done = { path: 'b.txt', maxBytes: 1024 };
  await expect(h.storage.completeUpload(h.ctx, done)).resolves.toMatchObject({ ok: true });
  expect(h.events.map((e) => e.action)).toEqual(['file-link-created', 'file-uploaded']);
  expect(h.events[1]).toMatchObject({ subjectId: pending.id, subjectLabel: 'b.txt' });
  // Completing again answers the ready file: no second upload row.
  await h.storage.completeUpload(h.ctx, done);
  expect(h.events).toHaveLength(2);
}

async function unaudittedSaves(h: AuditHarness) {
  await h.save('out.txt', 'abc', 'artifacts');
  const system = { workspaceId: h.ws.id, principalId: h.ws.principalId, userId: null };
  await h.storage.save(system, saveInput('sys.txt', 'abc', 1024));
  await expect(h.storage.save(h.ctx, saveInput('big.txt', 'abcdef', 3))).resolves.toEqual({
    ok: false,
    code: 'too_large',
  });
  expect(h.events).toEqual([]);
}

async function downloadIsAudited(h: AuditHarness) {
  const row = await h.save('a.txt', 'abc');
  h.events.length = 0;
  const read = await h.storage.open({ workspaceId: h.ws.id }, row);
  await read?.body.cancel();
  expect(h.events).toEqual([]);
  const download = await h.storage.open(h.ctx, row);
  await download?.body.cancel();
  expect(h.events).toEqual([
    eventOf(h, { action: 'file-downloaded', subjectId: row.id, subjectLabel: 'a.txt' }),
  ]);
}

async function rangedReadsAreEachAudited(h: AuditHarness) {
  const row = await h.save('a.txt', 'abcdef');
  h.events.length = 0;

  // Intended (#1772): one row per download request, a Range request included. Two reads of
  // the same range are two reads.
  for (const range of [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
    { start: 3, end: 5 },
  ]) {
    const read = await h.storage.open(h.ctx, row, range);
    await read?.body.cancel();
  }

  const downloaded = eventOf(h, {
    action: 'file-downloaded',
    subjectId: row.id,
    subjectLabel: 'a.txt',
  });
  expect(h.events).toEqual([downloaded, downloaded, downloaded]);
  expect(new Set(h.events.map((event) => event.id)).size).toBe(3);
}

async function moveIsAudited(h: AuditHarness) {
  const row = await h.save('a.txt', 'abc');
  h.events.length = 0;
  const moved = await h.storage.rename(h.ctx, 'files', 'a.txt', 'docs/b.txt');
  expect(moved).toMatchObject({ ok: true });
  expect(h.events).toEqual([
    eventOf(h, { action: 'file-moved', subjectId: row.id, subjectLabel: 'a.txt -> docs/b.txt' }),
  ]);
  // A refused move records nothing.
  const refused = await h.storage.rename(h.ctx, 'files', 'nope.txt', 'c.txt');
  expect(refused).toMatchObject({ ok: false });
  expect(h.events).toHaveLength(1);
}

async function linkCreationIsAudited(h: AuditHarness) {
  const row = await h.save('a.txt', 'abc');
  h.events.length = 0;
  expect(await h.storage.signDownload(h.ctx, row, link)).not.toBeNull();
  expect(h.events).toEqual([
    eventOf(h, { action: 'file-link-created', subjectId: row.id, subjectLabel: 'a.txt' }),
  ]);
  expect((await h.storage.reserveUpload(h.ctx, mintRequest('new.txt'))).ok).toBe(true);
  expect(h.events.map((e) => e.action)).toEqual(['file-link-created', 'file-link-created']);
  // A refused mint (a folder holds the path) records nothing.
  await h.storage.createFolder(h.ctx, 'dir');
  expect((await h.storage.reserveUpload(h.ctx, mintRequest('dir'))).ok).toBe(false);
  expect(h.events).toHaveLength(2);
}

async function signedUrlNeverAudited(h: AuditHarness) {
  const row = await h.save('a.txt', 'abc');
  const down = await h.storage.signDownload(h.ctx, row, link);
  const up = await h.storage.reserveUpload(h.ctx, mintRequest('b.txt'));
  // The links did carry the signature, so the assertion below can fail.
  expect(JSON.stringify([down, up])).toContain(h.signature);
  expect(h.events.map((e) => e.action)).toContain('file-link-created');
  expect(JSON.stringify(h.events)).not.toContain(h.signature);
  expect(JSON.stringify(h.events)).not.toContain('store.invalid');
}

defineAuditSuites(database, (test) => {
  // @story US-STO-01
  test('[US-STO-01][api][sdk] upload is audited', uploadIsAudited);
  // @story US-STO-01
  test(
    '[US-STO-01][api][sdk] run outputs, system callers and refused saves write no audit row',
    unaudittedSaves,
  );
  // @story US-STO-01
  test(
    '[US-STO-01][api][sdk] a download is audited, and the agent reading the same row is not',
    downloadIsAudited,
  );
  // @story US-STO-05
  test(
    '[US-STO-05][api][sdk] every ranged read is its own download row, so no read goes unaudited',
    rangedReadsAreEachAudited,
  );
  // @story US-STO-03
  test('[US-STO-03][api][sdk] move is audited', moveIsAudited);
  // @story US-STO-05
  test('[US-STO-05][api][sdk] link creation is audited', linkCreationIsAudited);
  // @story US-STO-05
  test('[US-STO-05][api][sdk] a signed URL never appears in any audit row', signedUrlNeverAudited);
});
