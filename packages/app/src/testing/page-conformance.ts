/**
 * The `PageStore` conformance suite (issue #1520): one set of cases both page stores must pass, run
 * on `memoryPageStoreOf` always and on `pageStoreOf` against PostgreSQL when `TEST_DATABASE_URL` is
 * set. It is handed the runner's `describe` and `it` and asserts with `node:assert`, as the
 * resource suite (`conformance.ts`) is. Only this package's tests use it.
 */
import assert from 'node:assert/strict';

import { AppStoreError, type AppStoreErrorCode } from '../db/errors.js';
import type { PageResource } from '../db/page-policy.js';
import type { PageRecord, PageRevision, PageStore } from '../db/page-port.js';
import { definePages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import { fakePerson } from './fake-person.js';

/** A page store under test, and every revision it keeps of a page, deleted pages' included. */
interface PageStoreHarness {
  readonly store: PageStore;
  readonly storedRevisions: (pageId: string) => Promise<readonly PageRevision[]>;
}

/** Makes a page store of `resource` on the clock `now`. */
export type MakePageStore = (
  resource: PageResource,
  options: { readonly now: () => Date },
) => PageStoreHarness | Promise<PageStoreHarness>;

/** The parts of a test runner the suite uses. */
interface TestRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

const access = {
  read: 'member',
  create: 'member',
  update: 'member',
  delete: 'role:admin',
} as const;

/** The main fixture: agents read and write the title and the body. */
const pages = definePages({ access, agents: { read: true, write: ['title', 'blocks'] } });

/** Pages kept in spaces. Its `space` references no table here: the store checks the tree only. */
const docs = definePages({ name: 'doc', space: true, access });

/** Every resource the suite uses, so a PostgreSQL harness can create their tables first. */
export const PAGE_CONFORMANCE_RESOURCES: readonly PageResource[] = [pages, docs];

/** A clock one millisecond on at every reading, so revisions are strictly ordered. */
function tickingClock(): () => Date {
  let at = Date.parse('2026-10-01T00:00:00.000Z');
  return () => {
    at += 1;
    return new Date(at);
  };
}

async function rejects(operation: Promise<unknown>, code: AppStoreErrorCode): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AppStoreError, `expected an AppStoreError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function paragraph(text: string): { readonly type: 'paragraph'; readonly text: string } {
  return { type: 'paragraph', text };
}

interface Fixture {
  readonly harness: PageStoreHarness;
  readonly store: PageStore;
  readonly admin: Person;
  readonly builder: Person;
}

async function fixture(makeStore: MakePageStore, resource: PageResource = pages): Promise<Fixture> {
  const harness = await makeStore(resource, { now: tickingClock() });
  const workspaceId = crypto.randomUUID();
  return {
    harness,
    store: harness.store,
    admin: fakePerson({ workspaceId, role: 'admin' }),
    builder: fakePerson({ workspaceId, role: 'builder' }),
  };
}

function titlesOf(records: readonly PageRecord[]): unknown[] {
  return records.map((record) => record['title']);
}

function registerTreeCases(runner: TestRunner, makeStore: MakePageStore): void {
  runner.it('nests pages and lists children by position, a new page last', async () => {
    const { store, builder } = await fixture(makeStore);
    const root = await store.create(builder, { title: 'Root', blocks: [] });
    const b = await store.create(builder, { title: 'B', parent: root.id, position: 5 });
    await store.create(builder, { title: 'A', parent: root.id, position: 1 });
    const last = await store.create(builder, { title: 'C', parent: root.id });
    assert.equal(last['position'], 6);
    assert.deepEqual(last['blocks'], []);
    assert.deepEqual(titlesOf(await store.children(builder, root.id)), ['A', 'B', 'C']);
    assert.deepEqual(titlesOf(await store.children(builder, null)), ['Root']);
    assert.deepEqual(titlesOf(await store.children(builder, b.id)), []);
  });

  runner.it('refuses a move under the page itself or below it: page_cycle', async () => {
    const { store, builder } = await fixture(makeStore);
    const top = await store.create(builder, { title: 'Top' });
    const middle = await store.create(builder, { title: 'Middle', parent: top.id });
    const bottom = await store.create(builder, { title: 'Bottom', parent: middle.id });
    await rejects(store.move(builder, top.id, { parent: bottom.id, position: 0 }), 'page_cycle');
    await rejects(store.move(builder, top.id, { parent: top.id, position: 0 }), 'page_cycle');
    const moved = await store.move(builder, bottom.id, { parent: null, position: 3 });
    assert.deepEqual([moved['parent'], moved['position']], [null, 3]);
    assert.deepEqual(titlesOf(await store.children(builder, null)), ['Top', 'Bottom']);
  });

  runner.it('refuses a parent change outside move, and a parent that is not a page', async () => {
    const { store, builder } = await fixture(makeStore);
    const one = await store.create(builder, { title: 'One' });
    const two = await store.create(builder, { title: 'Two' });
    await rejects(store.update(builder, two.id, { parent: one.id }), 'invalid_body');
    await store.update(builder, two.id, { parent: null, title: 'Two!' });
    const missing = crypto.randomUUID();
    await rejects(store.create(builder, { title: 'Lost', parent: missing }), 'invalid_body');
    await rejects(store.move(builder, two.id, { parent: missing, position: 0 }), 'invalid_body');
    await rejects(store.move(builder, two.id, { parent: one.id }), 'invalid_body');
  });

  runner.it('keeps a page and its parent in one space: page_space_mismatch', async () => {
    const { store, builder } = await fixture(makeStore, docs);
    const [red, blue] = [crypto.randomUUID(), crypto.randomUUID()];
    const redRoot = await store.create(builder, { title: 'Red', space: red });
    const blueRoot = await store.create(builder, { title: 'Blue', space: blue });
    await rejects(
      store.create(builder, { title: 'Stray', space: blue, parent: redRoot.id }),
      'page_space_mismatch',
    );
    const child = await store.create(builder, { title: 'Child', space: red, parent: redRoot.id });
    await rejects(
      store.move(builder, child.id, { parent: blueRoot.id, position: 0 }),
      'page_space_mismatch',
    );
  });

  runner.it(
    'refuses deleting a page with children, and a cascade keeps the revisions',
    async () => {
      const { harness, store, builder, admin } = await fixture(makeStore);
      const top = await store.create(builder, { title: 'Top' });
      const child = await store.create(builder, { title: 'Child', parent: top.id });
      await store.update(builder, child.id, { title: 'Child, edited' });
      await rejects(store.delete(admin, top.id), 'page_has_children');
      await rejects(store.delete(builder, child.id), 'forbidden');
      await store.delete(admin, top.id, { cascade: true });
      await rejects(store.get(admin, child.id), 'resource_not_found');
      assert.equal((await harness.storedRevisions(child.id)).length, 2);
      assert.equal((await harness.storedRevisions(top.id)).length, 1);
    },
  );
}

function registerRevisionCases(runner: TestRunner, makeStore: MakePageStore): void {
  runner.it('writes one revision per save of the title or body, none for a position', async () => {
    const { store, builder } = await fixture(makeStore);
    const page = await store.create(builder, { title: 'Draft', blocks: [paragraph('one')] });
    const edited = await store.update(builder, page.id, { blocks: [paragraph('two')] });
    await store.update(builder, page.id, { title: 'Final' });
    await store.update(builder, page.id, { position: 9 });
    await store.update(builder, page.id, { title: 'Final' });
    const revisions = await store.revisions(builder, page.id);
    assert.deepEqual(
      revisions.items.map((revision) => revision.title),
      ['Final', 'Draft', 'Draft'],
    );
    assert.equal(revisions.items[1]?.id, edited.revision_id);
    assert.equal((await store.get(builder, page.id)).revision_id, revisions.items[0]?.id);
    assert.deepEqual(revisions.items[2], {
      id: page.revision_id,
      workspace_id: builder.workspaceId,
      page_id: page.id,
      title: 'Draft',
      blocks: [paragraph('one')],
      author_principal_id: builder.principalId,
      run_id: null,
      at: revisions.items[2]?.at,
    });
    const first = await store.revisions(builder, page.id, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor !== null);
    const rest = await store.revisions(builder, page.id, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(
      rest.items.map((revision) => revision.id),
      [page.revision_id],
    );
    assert.equal(rest.nextCursor, null);
  });

  runner.it('restore makes a new revision, and the original is still listed', async () => {
    const { store, builder } = await fixture(makeStore);
    const page = await store.create(builder, { title: 'v1', blocks: [paragraph('first')] });
    await store.update(builder, page.id, { title: 'v2', blocks: [paragraph('second')] });
    const restored = await store.restore(builder, page.id, page.revision_id);
    assert.deepEqual([restored['title'], restored['blocks']], ['v1', [paragraph('first')]]);
    const ids = (await store.revisions(builder, page.id)).items.map((revision) => revision.id);
    assert.equal(ids.length, 3);
    assert.equal(ids[0], restored.revision_id);
    assert.equal(ids[2], page.revision_id);
    await rejects(store.restore(builder, page.id, crypto.randomUUID()), 'revision_not_found');
  });

  runner.it('stale expectedRevisionId → 409 page_conflict', async () => {
    const { store, builder } = await fixture(makeStore);
    const page = await store.create(builder, { title: 'Shared' });
    const theirs = await store.update(builder, page.id, {
      title: 'Theirs',
      expectedRevisionId: page.revision_id,
    });
    await assert.rejects(
      store.update(builder, page.id, { title: 'Mine', expectedRevisionId: page.revision_id }),
      (error: unknown) =>
        error instanceof AppStoreError && error.code === 'page_conflict' && error.status === 409,
    );
    await rejects(
      store.restore(builder, page.id, page.revision_id, { expectedRevisionId: page.revision_id }),
      'page_conflict',
    );
    const mine = await store.update(builder, page.id, {
      title: 'Mine',
      expectedRevisionId: theirs.revision_id,
    });
    assert.equal(mine['title'], 'Mine');
    await rejects(
      store.update(builder, page.id, { title: 'x', expectedRevisionId: 'nope' }),
      'invalid_body',
    );
  });

  runner.it('an agent save records its run; a person save after it does not', async () => {
    const { store, builder } = await fixture(makeStore);
    const page = await store.create(builder, { title: 'Notes' });
    const agent = fakePerson({ ...builder, via: 'agent', runId: 'run_page_1' });
    await store.update(agent, page.id, { blocks: [paragraph('by the agent')] });
    await store.update(builder, page.id, { blocks: [paragraph('by the person')] });
    const [personSave, agentSave] = (await store.revisions(builder, page.id)).items;
    assert.deepEqual(
      [agentSave?.run_id, agentSave?.author_principal_id],
      ['run_page_1', builder.principalId],
    );
    assert.equal(personSave?.run_id, null);
    await rejects(store.update(agent, page.id, { parent: null }), 'forbidden');
    await rejects(store.move(agent, page.id, { parent: null, position: 2 }), 'forbidden');
  });

  runner.it('refuses a block type a page does not hold', async () => {
    const { store, builder } = await fixture(makeStore);
    await assert.rejects(
      store.create(builder, { title: 'Odd', blocks: [{ type: 'callout', text: 'x' }] }),
      (error: unknown) =>
        error instanceof AppStoreError &&
        error.code === 'invalid_body' &&
        error.details?.[0] === 'blocks.0.type',
    );
  });
}

function registerSearchCases(runner: TestRunner, makeStore: MakePageStore): void {
  runner.it('finds a Japanese and an English word from a block, and the title', async () => {
    const { store, builder } = await fixture(makeStore);
    const page = await store.create(builder, {
      title: 'Pump room',
      blocks: [
        { type: 'heading1', text: '保守手順' },
        {
          type: 'bulleted_item',
          text: 'Close',
          children: [{ type: 'bulleted_item', text: 'the Valve first' }],
        },
      ],
    });
    await store.create(builder, { title: 'Other', blocks: [paragraph('nothing here')] });
    for (const query of ['手順', 'valve', 'PUMP', '保守 close']) {
      const found = await store.search(builder, query);
      assert.deepEqual(
        found.items.map((item) => item.id),
        [page.id],
        `searching ${query}`,
      );
    }
    assert.deepEqual((await store.search(builder, '手続')).items, []);
    await store.update(builder, page.id, { blocks: [paragraph('replaced')] });
    assert.deepEqual((await store.search(builder, 'valve')).items, []);
    await rejects(store.search(builder, '!!'), 'invalid_query');
  });

  runner.it(
    'keeps workspaces apart: another workspace sees no page, child or revision',
    async () => {
      const { store, builder } = await fixture(makeStore);
      const page = await store.create(builder, { title: 'Private 手順' });
      const stranger = fakePerson({ workspaceId: crypto.randomUUID() });
      await rejects(store.get(stranger, page.id), 'resource_not_found');
      await rejects(store.children(stranger, page.id), 'resource_not_found');
      await rejects(store.revisions(stranger, page.id), 'resource_not_found');
      await rejects(store.update(stranger, page.id, { title: 'Mine' }), 'resource_not_found');
      await rejects(store.restore(stranger, page.id, page.revision_id), 'resource_not_found');
      assert.deepEqual(await store.children(stranger, null), []);
      assert.deepEqual((await store.search(stranger, '手順')).items, []);
      assert.deepEqual((await store.list(stranger)).items, []);
    },
  );
}

/**
 * Registers the suite under `name`: the tree (children, moves, the cycle and space rules, the
 * delete rule), the revisions (one per save, restore, the optimistic check, the agent's run) and
 * search with workspace isolation.
 */
export function describePageStoreConformance(
  name: string,
  makeStore: MakePageStore,
  runner: TestRunner,
): void {
  runner.describe(name, () => {
    registerTreeCases(runner, makeStore);
    registerRevisionCases(runner, makeStore);
    registerSearchCases(runner, makeStore);
  });
}
