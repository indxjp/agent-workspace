import { expect } from 'vitest';

import { createInMemoryObjectStore, storageObjectName } from '@agent-workspace/core/storage';

import {
  bytesOf,
  defineAuditSuites,
  eventOf,
  mintRequest,
  noLog,
  saveInput,
  useIsolatedAuditDatabase,
  type AuditHarness,
} from './audit.test-support';
import { createStorageService } from './service';

const database = useIsolatedAuditDatabase();

async function retriedCompleteReAudits(h: AuditHarness) {
  expect((await h.storage.reserveUpload(h.ctx, mintRequest('b.txt'))).ok).toBe(true);
  const pending = await h.catalog.pending('b.txt');
  if (pending === null) throw new Error('no pending row');
  await h.objects.write(
    storageObjectName(h.ws.id, 'files', pending.objectId ?? ''),
    bytesOf('xyz'),
    { contentType: null },
  );
  const done = { path: 'b.txt', maxBytes: 1024 };
  h.events.length = 0;
  // Down for the write and its one in-process retry: the upload commits, the caller sees the error.
  h.failing.next = 2;
  await expect(h.storage.completeUpload(h.ctx, done)).rejects.toThrow('audit down');
  expect(h.events).toEqual([]);

  // The caller's retry finds the upload done and records it now.
  await expect(h.storage.completeUpload(h.ctx, done)).resolves.toMatchObject({ ok: true });
  expect(h.events).toEqual([
    eventOf(h, { action: 'file-uploaded', subjectId: pending.id, subjectLabel: 'b.txt' }),
  ]);
  // A further retry writes the same key again, which the trail keeps once.
  await h.storage.completeUpload(h.ctx, done);
  expect(h.events).toHaveLength(1);
}

async function removeAndExpectDeletedRow(h: AuditHarness, rowId: string) {
  await expect(
    h.storage.remove(h.ctx, 'files', 'docs/a.txt', { recursive: false }),
  ).resolves.toMatchObject({ ok: true });
  expect(h.events).toEqual([
    eventOf(h, { action: 'file-deleted', subjectId: rowId, subjectLabel: 'docs/a.txt' }),
  ]);
}

async function lostReplyKeptOnce(h: AuditHarness) {
  const row = await h.save('docs/a.txt', 'abc');
  h.events.length = 0;
  h.failing.next = 1;
  h.failing.landed = true;
  await removeAndExpectDeletedRow(h, row.id);
}

async function twoUploadsTwoRows(h: AuditHarness) {
  await h.save('a.txt', 'one');
  await h.save('a.txt', 'two');
  expect(h.events.map((event) => event.action)).toEqual(['file-uploaded', 'file-uploaded']);
  expect(new Set(h.events.map((event) => event.id)).size).toBe(2);
}

async function failedWriteReachesCaller(h: AuditHarness) {
  const storage = createStorageService({
    catalog: h.fixture.catalog,
    objects: createInMemoryObjectStore(),
    log: noLog,
    audit: () => Promise.reject(new Error('audit down')),
  });
  await expect(storage.save(h.ctx, saveInput('a.txt', 'abc', 1024))).rejects.toThrow('audit down');
  // The upload committed: the file is there and nothing was deleted.
  await expect(h.catalog.get('a.txt')).resolves.toMatchObject({ status: 'ready', sizeBytes: 3 });
}

async function deleteWritesAuditRow(h: AuditHarness) {
  const row = await h.save('docs/a.txt', 'abc');
  h.events.length = 0;
  await removeAndExpectDeletedRow(h, row.id);
}

async function deleteThatMarkedNothingIsNotAudited(h: AuditHarness) {
  await h.save('docs/a.txt', 'abc');
  h.events.length = 0;
  // A concurrent delete wins the race: by the time this one marks, the row is already gone.
  const racing = createStorageService({
    catalog: () =>
      Promise.resolve({
        ...h.catalog,
        remove: async (target: string) => {
          await h.catalog.remove(target);
          return h.catalog.remove(target);
        },
      }),
    objects: h.objects,
    log: noLog,
    audit: (event) => {
      h.events.push(event);
      return Promise.resolve();
    },
  });
  await expect(racing.remove(h.ctx, 'files', 'docs/a.txt', { recursive: false })).resolves.toEqual({
    ok: true,
    removed: 0,
    files: [],
  });
  expect(h.events).toEqual([]);
}

defineAuditSuites(database, (test) => {
  // @story US-STO-02
  test(
    '[US-STO-02][api][sdk] a retried upload complete re-audits a failed audit write, under the same key',
    retriedCompleteReAudits,
  );
  // @story US-STO-04
  test(
    '[US-STO-04][api][sdk] an audit write whose reply is lost is retried under the same key and kept once',
    lostReplyKeptOnce,
  );
  // @story US-STO-04
  test(
    '[US-STO-04][api][sdk] two uploads to one path are two audit rows, each under its own key',
    twoUploadsTwoRows,
  );
  // @story US-STO-04
  test(
    '[US-STO-04][api][sdk] a failed audit write keeps the action and reaches the caller',
    failedWriteReachesCaller,
  );
  // @story US-STO-04
  test(
    '[US-STO-04][api][sdk] deleting a file writes a file-deleted audit row with the actor',
    deleteWritesAuditRow,
  );
  // @story US-STO-04
  test(
    '[US-STO-04][api][sdk] a delete that marked no row writes no file-deleted audit row',
    deleteThatMarkedNothingIsNotAudited,
  );
});
