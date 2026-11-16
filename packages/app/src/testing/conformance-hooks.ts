/**
 * The conformance cases for a store's hooks: `onCommitted` (issue #1513) and `afterWrite`
 * (issue #1519).
 */
import assert from 'node:assert/strict';

import { AppStoreError } from '../db/errors.js';
import type { ResourceStore } from '../db/port.js';
import { fakePerson } from './fake-person.js';
import {
  manualClock,
  rejects,
  tickets,
  workspace,
  type MakeStore,
  type TestRunner,
} from './conformance-support.js';

/** The `onCommitted` hook (issue #1513): once per committed write, never for a refused one. */
export function registerCommittedCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it(
    'calls onCommitted once after each committed write, never after a refused one',
    async () => {
      const seen: string[] = [];
      const { store } = await makeStore(tickets, {
        ...manualClock(),
        onCommitted: (resource, event, row, who) => {
          seen.push(`${resource}:${event}:${String(row['title'])}:${who.principalId}`);
        },
      });
      const admin = fakePerson({ workspaceId: workspace(), role: 'admin' });
      const viewer = fakePerson({ workspaceId: admin.workspaceId, role: 'viewer' });
      const record = await store.create(admin, { title: 'one' });
      await store.update(admin, record.id, { title: 'two' });
      await rejects(store.update(admin, record.id, { title: 'x'.repeat(201) }), 'invalid_body');
      await rejects(store.delete(viewer, record.id), 'forbidden');
      await rejects(store.update(admin, crypto.randomUUID(), { title: 'x' }), 'resource_not_found');
      await store.delete(admin, record.id);
      const id = admin.principalId;
      assert.deepEqual(seen, [
        `ticket:created:one:${id}`,
        `ticket:updated:two:${id}`,
        `ticket:deleted:two:${id}`,
      ]);
    },
  );

  runner.it('keeps a write committed when its onCommitted hook throws', async () => {
    const { store } = await makeStore(tickets, {
      ...manualClock(),
      onCommitted: () => Promise.reject(new Error('the hook failed')),
    });
    const admin = fakePerson({ workspaceId: workspace(), role: 'admin' });
    const record = await store.create(admin, { title: 'kept' });
    assert.equal((await store.get(admin, record.id))['title'], 'kept');
  });
}

/**
 * The `afterWrite` hook (issue #1519): called in the write's transaction, before the write is
 * visible to anyone else, and a hook that throws rolls the write back.
 */
export function registerAfterWriteCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it(
    'calls afterWrite once per write, before the write is visible, never for a refused one',
    async () => {
      const seen: string[] = [];
      // The hook reads the store it is a hook of, which exists only once makeStore returns.
      const made: { store?: ResourceStore } = {};
      const admin = fakePerson({ workspaceId: workspace(), role: 'admin' });
      const viewer = fakePerson({ workspaceId: admin.workspaceId, role: 'viewer' });
      const harness = await makeStore(tickets, {
        ...manualClock(),
        afterWrite: async (_tx, change) => {
          assert.ok(made.store !== undefined);
          const id = String(change.row['id']);
          // Outside the transaction, the write is not there yet.
          const outside = await made.store.get(admin, id).then(
            (record) => String(record['title']),
            (error: unknown) => (error instanceof AppStoreError ? error.code : 'other'),
          );
          seen.push(
            `${change.resource}:${change.type}:${String(change.row['title'])}:${outside}:${change.person.principalId}`,
          );
        },
      });
      const { store } = harness;
      made.store = store;
      const record = await store.create(admin, { title: 'one' });
      await store.update(admin, record.id, { title: 'two' });
      await rejects(store.update(admin, record.id, { title: 'x'.repeat(201) }), 'invalid_body');
      await rejects(store.delete(viewer, record.id), 'forbidden');
      await store.delete(admin, record.id);
      const id = admin.principalId;
      assert.deepEqual(seen, [
        `ticket:created:one:resource_not_found:${id}`,
        `ticket:updated:two:one:${id}`,
        `ticket:deleted:two:two:${id}`,
      ]);
    },
  );

  runner.it('rolls a write back when its afterWrite hook throws', async () => {
    let failing = false;
    const committed: string[] = [];
    const { store, auditEvents } = await makeStore(tickets, {
      ...manualClock(),
      afterWrite: () =>
        failing ? Promise.reject(new Error('the hook failed')) : Promise.resolve(),
      onCommitted: (_resource, event) => {
        committed.push(event);
      },
    });
    const admin = fakePerson({ workspaceId: workspace(), role: 'admin' });
    const record = await store.create(admin, { title: 'kept' });
    failing = true;
    // A hook's failure is the store's `internal_error`, the original kept as the cause.
    const internal = (error: unknown): boolean =>
      error instanceof AppStoreError &&
      error.code === 'internal_error' &&
      error.cause instanceof Error;
    await assert.rejects(store.create(admin, { title: 'rolled back' }), internal);
    await assert.rejects(store.update(admin, record.id, { title: 'rolled back' }), internal);
    await assert.rejects(store.delete(admin, record.id), internal);
    const page = await store.list(admin);
    assert.deepEqual(
      page.items.map((item) => item['title']),
      ['kept'],
    );
    assert.deepEqual(committed, ['created']);
    const audit = (await auditEvents()).filter((event) => event.workspace_id === admin.workspaceId);
    assert.deepEqual(
      audit.map((event) => event.action),
      ['create'],
    );
  });
}
