/**
 * The `ResourceStore` conformance suite (issue #1502): one set of cases every store must pass, run
 * on `memoryStoreOf` always and on `storeOf` against PostgreSQL when `TEST_DATABASE_URL` is set.
 * Passing it is what makes the in-memory store a faithful twin.
 *
 * It is handed the test runner's `describe` and `it` rather than importing one, and asserts with
 * `node:assert`, so it is not tied to a runner. Only this package's tests use it.
 */
import assert from 'node:assert/strict';

import { enumOf, number, person, richText, text } from '../fields/index.js';
import type { Person } from '../person.js';
import { defineResource, type AccessRule, type DefinedResource } from '../resource.js';
import { AppStoreError, type AppStoreErrorCode } from '../db/errors.js';
import type { AfterWrite, AuditEvent, OnCommitted, ResourceStore } from '../db/port.js';
import { fakePerson } from './fake-person.js';

/** A store under test and the audit rows it has written. */
interface StoreHarness {
  readonly store: ResourceStore;
  readonly auditEvents: () => Promise<readonly AuditEvent[]>;
}

/** Makes a store of `resource`; `now` is its clock, and `afterWrite` and `onCommitted` its hooks. */
export type MakeStore = (
  resource: DefinedResource,
  options: {
    readonly now: () => Date;
    readonly afterWrite?: AfterWrite;
    readonly onCommitted?: OnCommitted;
  },
) => StoreHarness | Promise<StoreHarness>;

/** The parts of a test runner the suite uses. */
export interface TestRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

const ticketFields = {
  title: text({ max: 200 }),
  body: richText({ optional: true }),
  status: enumOf(['open', 'pending', 'closed'], { default: 'open' }),
  assignee: person({ optional: true }),
  priority: number({ min: 0, max: 10, optional: true }),
};

/** The main fixture: searched, audited, with a board, agents writing two fields. */
const tickets = defineResource({
  name: 'ticket',
  fields: ticketFields,
  access: {
    read: 'member',
    create: 'member',
    update: ['role:admin', 'assignee'],
    delete: 'role:admin',
  },
  agents: { read: true, write: ['title', 'status'] },
  search: ['title', 'body'],
  board: 'status',
});

/** No search, no audit, no agents. */
const notes = defineResource({
  name: 'note',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  audit: false,
});

/** The access rules the matrix covers, each with the people (below) it admits. */
const MATRIX: readonly (readonly [
  string,
  AccessRule | readonly AccessRule[],
  readonly string[],
])[] = [
  ['member', 'member', ['viewer', 'builder', 'admin', 'owner', 'assigned']],
  ['role_viewer', 'role:viewer', ['viewer', 'builder', 'admin', 'owner', 'assigned']],
  ['role_builder', 'role:builder', ['builder', 'admin', 'owner']],
  ['role_admin', 'role:admin', ['admin', 'owner']],
  ['role_owner', 'role:owner', ['owner']],
  ['assignee', 'assignee', ['assigned', 'assigned_guest']],
  ['any_of', ['role:admin', 'assignee'], ['admin', 'owner', 'assigned', 'assigned_guest']],
];

function matrixResource(
  slug: string,
  rule: AccessRule | readonly AccessRule[],
  family: 'read' | 'write',
): DefinedResource {
  const rules = rule as AccessRule;
  return defineResource({
    name: `${family}_${slug}`,
    fields: { title: text(), assignee: person({ optional: true }) },
    access:
      family === 'read'
        ? { read: rules, create: 'member', update: 'member', delete: 'member' }
        : { read: 'member', create: rules, update: rules, delete: rules },
    audit: false,
  });
}

const matrixResources = MATRIX.flatMap(([slug, rule]) => [
  matrixResource(slug, rule, 'read'),
  matrixResource(slug, rule, 'write'),
]);

/** The `onCommitted` hook (issue #1513): once per committed write, never for a refused one. */
function registerCommittedCases(runner: TestRunner, makeStore: MakeStore): void {
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
function registerAfterWriteCases(runner: TestRunner, makeStore: MakeStore): void {
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
    await assert.rejects(store.create(admin, { title: 'rolled back' }));
    await assert.rejects(store.update(admin, record.id, { title: 'rolled back' }));
    await assert.rejects(store.delete(admin, record.id));
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

/** Every resource the suite uses, so a PostgreSQL harness can create their tables first. */
export const CONFORMANCE_RESOURCES: readonly DefinedResource[] = [
  tickets,
  notes,
  ...matrixResources,
];

/** The people of the matrix, in one workspace; the `assigned*` ones are a record's assignee. */
function matrixPeople(workspaceId: string): Readonly<Record<string, Person>> {
  return {
    guest: fakePerson({ workspaceId, role: null }),
    viewer: fakePerson({ workspaceId, role: 'viewer' }),
    builder: fakePerson({ workspaceId, role: 'builder' }),
    admin: fakePerson({ workspaceId, role: 'admin' }),
    owner: fakePerson({ workspaceId, role: 'owner' }),
    assigned: fakePerson({ workspaceId, role: 'viewer' }),
    assigned_guest: fakePerson({ workspaceId, role: null }),
  };
}

function principalOf(people: Readonly<Record<string, Person>>, label: string): string {
  const one = people[label];
  assert.ok(one !== undefined, `no ${label} in the matrix`);
  return one.principalId;
}

async function rejects(
  operation: Promise<unknown>,
  code: AppStoreErrorCode,
  details?: readonly string[],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AppStoreError, `expected an AppStoreError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

/** A clock a test moves by hand. */
function manualClock(): { now: () => Date; set(at: string): void } {
  let current = new Date('2026-10-01T00:00:00.000Z');
  return {
    now: () => new Date(current),
    set(at: string) {
      current = new Date(at);
    },
  };
}

function workspace(): string {
  return crypto.randomUUID();
}

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

/**
 * Makes a record assigned to `assigneeId`, written by an owner who is that assignee, so every rule
 * of the matrix admits the write.
 */
async function seedAssigned(
  store: ResourceStore,
  workspaceId: string,
  assigneeId: string,
): Promise<string> {
  const writer = fakePerson({ workspaceId, role: 'owner', principalId: assigneeId });
  const record = await store.create(writer, { title: 'seeded', assignee: assigneeId });
  return record.id;
}

async function checkRead(
  makeStore: MakeStore,
  slug: string,
  admitted: readonly string[],
): Promise<void> {
  const resource = matrixResources.find((one) => one.name === `read_${slug}`);
  assert.ok(resource !== undefined);
  const { store } = await makeStore(resource, manualClock());
  const workspaceId = workspace();
  const people = matrixPeople(workspaceId);
  const id = await seedAssigned(store, workspaceId, principalOf(people, 'assigned'));
  const guestId = await seedAssigned(store, workspaceId, principalOf(people, 'assigned_guest'));
  for (const [label, who] of Object.entries(people)) {
    const own = label === 'assigned_guest' ? guestId : id;
    const may = admitted.includes(label);
    const listed = (await store.list(who)).items.map((item) => item.id);
    assert.equal(listed.includes(own), may, `read ${slug}: ${label} lists the record`);
    if (may) assert.equal((await store.get(who, own)).id, own);
    else await rejects(store.get(who, own), 'resource_not_found');
  }
}

async function checkWrite(
  makeStore: MakeStore,
  slug: string,
  admitted: readonly string[],
): Promise<void> {
  const resource = matrixResources.find((one) => one.name === `write_${slug}`);
  assert.ok(resource !== undefined);
  const { store } = await makeStore(resource, manualClock());
  const workspaceId = workspace();
  const people = matrixPeople(workspaceId);
  for (const [label, who] of Object.entries(people)) {
    const assigned = label.startsWith('assigned');
    const may = admitted.includes(label);
    const assignee = assigned ? who.principalId : crypto.randomUUID();
    const create = store.create(who, { title: 'new', assignee });
    if (may) await create;
    else await rejects(create, 'forbidden');
    // A guest reads nothing under `read: 'member'`, so its update and delete are concealed.
    const canRead = who.role !== null;
    const target = await seedAssigned(store, workspaceId, assignee);
    const update = store.update(who, target, { title: 'changed' });
    const remove = (): Promise<void> => store.delete(who, target);
    if (!canRead) {
      await rejects(update, 'resource_not_found');
      await rejects(remove(), 'resource_not_found');
    } else if (may) {
      await update;
      await remove();
    } else {
      await rejects(update, 'forbidden');
      await rejects(remove(), 'forbidden');
    }
  }
}

function registerAccessMatrix(runner: TestRunner, makeStore: MakeStore): void {
  for (const [slug, , admitted] of MATRIX) {
    runner.it(`access matrix: read rule ${slug}`, () => checkRead(makeStore, slug, admitted));
    runner.it(`access matrix: create, update and delete rule ${slug}`, () =>
      checkWrite(makeStore, slug, admitted),
    );
  }
}

function registerAgentCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it('an agent write within agents.write succeeds, in its run', async () => {
    const { store, auditEvents } = await makeStore(tickets, manualClock());
    const workspaceId = workspace();
    const admin = fakePerson({ workspaceId, role: 'admin' });
    const agent = fakePerson({
      workspaceId,
      role: 'admin',
      via: 'agent',
      principalId: admin.principalId,
    });
    const record = await store.create(agent, { title: 'filed by an agent' });
    const updated = await store.update(agent, record.id, { status: 'pending' });
    assert.equal(updated['status'], 'pending');
    const events = (await auditEvents()).filter((event) => event.record_id === record.id);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.via, 'agent');
      assert.equal(event.run_id, agent.runId);
    }
  });

  runner.it('an agent write outside agents.write is forbidden', async () => {
    const { store } = await makeStore(tickets, manualClock());
    const workspaceId = workspace();
    const admin = fakePerson({ workspaceId, role: 'admin' });
    const agent = fakePerson({ workspaceId, role: 'admin', via: 'agent' });
    const record = await store.create(admin, { title: 'by hand' });
    await rejects(store.update(agent, record.id, { priority: 3 }), 'forbidden', [
      'fields:priority',
    ]);
    await rejects(
      store.create(agent, { title: 'x', priority: 1, assignee: admin.principalId }),
      'forbidden',
      ['fields:assignee', 'fields:priority'],
    );
    const other = await makeStore(notes, manualClock());
    await rejects(other.store.create(agent, { title: 'x' }), 'forbidden', ['agents.write']);
    const runless = { ...agent, runId: undefined } as unknown as Person;
    await rejects(store.update(runless, record.id, { status: 'closed' }), 'forbidden', ['run_id']);
    assert.equal((await store.get(admin, record.id))['priority'], null);
  });

  runner.it("an agent cannot exceed the person's access", async () => {
    const { store } = await makeStore(tickets, manualClock());
    const workspaceId = workspace();
    const admin = fakePerson({ workspaceId, role: 'admin' });
    const builderAgent = fakePerson({ workspaceId, role: 'builder', via: 'agent' });
    const guestAgent = fakePerson({ workspaceId, role: null, via: 'agent' });
    const record = await store.create(admin, { title: 'admins only' });
    // `update` is admin-or-assignee and `delete` admin: a builder's agent may do neither, even on
    // a field agents may write.
    await rejects(store.update(builderAgent, record.id, { status: 'closed' }), 'forbidden');
    await rejects(store.delete(builderAgent, record.id), 'forbidden');
    await rejects(store.create(guestAgent, { title: 'x' }), 'forbidden');
    const adminAgent = fakePerson({ workspaceId, role: 'admin', via: 'agent' });
    await store.delete(adminAgent, record.id);
  });

  runner.it('an agent reads only where the resource lets agents read', async () => {
    const other = await makeStore(notes, manualClock());
    const agent = fakePerson({ role: 'owner', via: 'agent', workspaceId: workspace() });
    await rejects(other.store.list(agent), 'forbidden', ['agents.read']);
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
