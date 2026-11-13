/**
 * The `ResourceStore` conformance suite (issue #1502): one set of cases every store must pass, run
 * on `memoryStoreOf` always and on `storeOf` against PostgreSQL when `TEST_DATABASE_URL` is set.
 * Passing it is what makes the in-memory store a faithful twin.
 *
 * It is handed the test runner's `describe` and `it` rather than importing one, and asserts with
 * `node:assert`, so it is not tied to a runner. Only this package's tests use it.
 */
import assert from 'node:assert/strict';

import type { DefinedResource } from '../resource.js';
import type { ResourceStore } from '../db/port.js';
import { fakePerson } from './fake-person.js';
import { registerAgentCases, registerAccessMatrix } from './conformance-access.js';
import { registerAfterWriteCases, registerCommittedCases } from './conformance-hooks.js';
import {
  manualClock,
  matrixResources,
  notes,
  rejects,
  tickets,
  workspace,
  type MakeStore,
  type TestRunner,
} from './conformance-support.js';

export type { MakeStore, TestRunner } from './conformance-support.js';

/** Every resource the suite uses, so a PostgreSQL harness can create their tables first. */
export const CONFORMANCE_RESOURCES: readonly DefinedResource[] = [
  tickets,
  notes,
  ...matrixResources,
];

function registerIsolationCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it('workspace B can neither list nor get a record of workspace A', async () => {
    const { store } = await makeStore(tickets, manualClock());
    const a = fakePerson({ workspaceId: workspace(), role: 'owner' });
    const b = fakePerson({ workspaceId: workspace(), role: 'owner' });
    const record = await store.create(a, { title: 'only in A' });
    assert.deepEqual((await store.list(b)).items, []);
    await rejects(store.get(b, record.id), 'resource_not_found');
    await rejects(store.update(b, record.id, { title: 'x' }), 'resource_not_found');
    await rejects(store.delete(b, record.id), 'resource_not_found');
    assert.equal((await store.get(a, record.id))['title'], 'only in A');
  });

  runner.it("refuses workspace A's cursor in workspace B, and another list's cursor", async () => {
    const { store } = await makeStore(tickets, manualClock());
    const a = fakePerson({ workspaceId: workspace(), role: 'owner' });
    const b = fakePerson({ workspaceId: workspace(), role: 'owner' });
    await store.create(a, { title: 'one' });
    await store.create(a, { title: 'two' });
    const first = await store.list(a, { limit: 1 });
    assert.ok(first.nextCursor !== null);
    await rejects(store.list(b, { cursor: first.nextCursor }), 'invalid_cursor');
    await rejects(store.search(a, 'one', { cursor: first.nextCursor }), 'invalid_cursor');
    const other = await makeStore(notes, manualClock());
    await rejects(other.store.list(a, { cursor: first.nextCursor }), 'invalid_cursor');
    await rejects(store.list(a, { cursor: `${first.nextCursor}x` }), 'invalid_cursor');
  });
}

function registerPagingCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it('pages newest first and splits equal created_at by id, losing nothing', async () => {
    const clock = manualClock();
    const { store } = await makeStore(tickets, clock);
    const someone = fakePerson({ workspaceId: workspace() });
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push((await store.create(someone, { title: `same time ${String(index)}` })).id);
    }
    clock.set('2026-10-02T00:00:00.000Z');
    const newest = await store.create(someone, { title: 'newest' });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<ResourceStore['list']>> = await store.list(someone, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(seen, [newest.id, ...[...ids].sort().reverse()]);
  });

  runner.it('validates the limit and the where filter', async () => {
    const { store } = await makeStore(tickets, manualClock());
    const someone = fakePerson({ workspaceId: workspace() });
    await store.create(someone, { title: 'open one' });
    await store.create(someone, { title: 'closed one', status: 'closed' });
    const closed = await store.list(someone, { where: { status: 'closed' } });
    assert.deepEqual(
      closed.items.map((item) => item['title']),
      ['closed one'],
    );
    await rejects(store.list(someone, { limit: 0 }), 'invalid_limit');
    await rejects(store.list(someone, { limit: 201 }), 'invalid_limit');
    await rejects(store.list(someone, { where: { status: 'gone' } }), 'invalid_query', [
      'where.status',
    ]);
    await rejects(store.list(someone, { where: { title: 'x' } }), 'invalid_query', ['where.title']);
  });
}

function registerRecordCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it('creates with defaults, reads back, updates and deletes a record', async () => {
    const { store } = await makeStore(tickets, manualClock());
    const admin = fakePerson({ workspaceId: workspace(), role: 'admin' });
    const created = await store.create(admin, {
      title: 'Printer jam',
      body: [{ type: 'p', text: 'Tray 2' }],
      priority: 2.5,
    });
    assert.equal(created['status'], 'open');
    assert.equal(created['assignee'], null);
    assert.equal(created.workspace_id, admin.workspaceId);
    assert.equal(created.created_by, admin.principalId);
    assert.deepEqual(await store.get(admin, created.id), created);
    const updated = await store.update(admin, created.id, { status: 'closed', priority: null });
    assert.equal(updated['status'], 'closed');
    assert.equal(updated['priority'], null);
    assert.equal(updated['title'], 'Printer jam');
    await store.delete(admin, created.id);
    await rejects(store.get(admin, created.id), 'resource_not_found');
    await rejects(store.get(admin, 'not-a-uuid'), 'resource_not_found');
  });

  runner.it('refuses an invalid body with the dotted path of every problem', async () => {
    const { store } = await makeStore(tickets, manualClock());
    const someone = fakePerson({ workspaceId: workspace() });
    await rejects(store.create(someone, { title: 5, extra: true }), 'invalid_body', [
      'title',
      'extra',
    ]);
    await rejects(store.create(someone, {}), 'invalid_body', ['title']);
    await rejects(store.create(someone, 'text'), 'invalid_body', ['$']);
    const record = await store.create(someone, { title: 'ok' });
    await rejects(store.update(someone, record.id, { priority: 11 }), 'invalid_body', ['priority']);
    await rejects(store.update(someone, record.id, { title: null }), 'invalid_body', ['title']);
  });

  runner.it('searches the declared fields, and refuses search where none is declared', async () => {
    const { store } = await makeStore(tickets, manualClock());
    const someone = fakePerson({ workspaceId: workspace() });
    await store.create(someone, { title: 'Printer jam on floor two' });
    await store.create(someone, { title: 'Network down', body: [{ type: 'p', text: 'printer' }] });
    await store.create(someone, { title: 'Coffee machine' });
    const found = await store.search(someone, 'printer');
    assert.deepEqual(found.items.map((item) => item['title']).sort(), [
      'Network down',
      'Printer jam on floor two',
    ]);
    const narrowed = await store.search(someone, 'printer jam');
    assert.deepEqual(
      narrowed.items.map((item) => item['title']),
      ['Printer jam on floor two'],
    );
    const elsewhere = fakePerson({ workspaceId: workspace() });
    assert.deepEqual((await store.search(elsewhere, 'printer')).items, []);
    await rejects(store.search(someone, '   '), 'invalid_query', ['q']);
    const other = await makeStore(notes, manualClock());
    await rejects(other.store.search(someone, 'printer'), 'search_unsupported');
  });
}

function registerAuditCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it('writes one audit row per write, naming fields but never values', async () => {
    const { store, auditEvents } = await makeStore(tickets, manualClock());
    const admin = fakePerson({ workspaceId: workspace(), role: 'admin' });
    const record = await store.create(admin, { title: 'secret title' });
    await store.update(admin, record.id, { priority: 4 });
    await store.delete(admin, record.id);
    const events = (await auditEvents()).filter((event) => event.record_id === record.id);
    const byAction = Object.fromEntries(events.map((event) => [event.action, event]));
    assert.equal(events.length, 3);
    assert.deepEqual(byAction['create']?.fields, ['title', 'status']);
    assert.deepEqual(byAction['update']?.fields, ['priority']);
    assert.deepEqual(byAction['delete']?.fields, []);
    for (const event of events) {
      assert.equal(event.actor, admin.principalId);
      assert.equal(event.via, 'person');
      assert.equal(event.run_id, null);
      assert.equal(event.resource, 'ticket');
      assert.equal(event.workspace_id, admin.workspaceId);
      assert.ok(!JSON.stringify(event).includes('secret title'));
    }
  });

  runner.it('writes no audit row when the resource says audit: false', async () => {
    const { store, auditEvents } = await makeStore(notes, manualClock());
    const someone = fakePerson({ workspaceId: workspace() });
    const record = await store.create(someone, { title: 'unaudited' });
    await store.update(someone, record.id, { title: 'still unaudited' });
    await store.delete(someone, record.id);
    const events = (await auditEvents()).filter((event) => event.record_id === record.id);
    assert.deepEqual(events, []);
  });
}

/**
 * Registers the suite under `name`: workspace isolation, cursors, paging, validation, search, the
 * access matrix, the agent rules and auditing.
 */
export function describeResourceStoreConformance(
  name: string,
  makeStore: MakeStore,
  runner: TestRunner,
): void {
  runner.describe(name, () => {
    registerIsolationCases(runner, makeStore);
    registerPagingCases(runner, makeStore);
    registerRecordCases(runner, makeStore);
    registerAccessMatrix(runner, makeStore);
    registerAgentCases(runner, makeStore);
    registerAuditCases(runner, makeStore);
    registerCommittedCases(runner, makeStore);
    registerAfterWriteCases(runner, makeStore);
  });
}
