/**
 * The transcript store conformance suite — **one suite, every implementation of the port**.
 *
 * Written against {@link TranscriptStore} (the port the session routes hold), not against an
 * implementation, and exported as {@link describeTranscriptStoreConformance}. It runs against:
 *
 *   1. {@link InMemoryTranscriptStore} — no database, always;
 *   2. {@link DatabaseTranscriptStore} over a **real PostgreSQL**, whenever `TEST_DATABASE_URL`
 *      names one.
 *
 * Two implementations tested by two suites are two contracts, and the durable one is the one
 * nobody runs locally (W2-DB-02). Here it matters more than usual, because the rules being checked
 * are not this repository's inventions — they are R-01 §7's report of what the Agent SDK
 * *requires* of a `SessionStore`, and a store that breaks one of them produces a resume that
 * silently loses a turn rather than an error anybody sees.
 *
 * Each `it` below names the rule it is enforcing and where the rule comes from.
 */
import crypto from 'node:crypto';

import {
  agents,
  createDatabaseSessionTranscriptRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseTranscriptStore } from './store';
import { InMemoryTranscriptStore } from './memory-store';
import {
  mergeTranscriptEntries,
  parseProjectKey,
  parseSessionId,
  parseSubpath,
  parseTranscriptEntries,
  parseTranscriptEntry,
  parseTranscriptKey,
  type TranscriptEntry,
  type TranscriptKey,
  type TranscriptStore,
} from './transcript';

const PROJECT = 'workspace-0000-0001';
const SESSION = '11111111-2222-4333-8444-555555555555';
const SUBAGENT = 'subagents/agent-7';

function entry(type: string, extra: Record<string, unknown> = {}): TranscriptEntry {
  return { type, ...extra };
}

/** One set-up for one test: a store and two workspaces that really exist in it. */
export interface TranscriptStoreFixture {
  readonly store: TranscriptStore;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** A platform session in `workspaceId` a transcript may be written under; returns its id. */
  readonly session: (workspaceId: string) => Promise<string>;
}

export type MakeTranscriptStoreFixture = () => Promise<TranscriptStoreFixture>;

/** Run the conformance suite against a fixture factory, called once per test. */
export function describeTranscriptStoreConformance(
  label: string,
  makeFixture: MakeTranscriptStoreFixture,
): void {
  /** A fresh fixture plus the main key of one new session in workspace A. */
  async function setUp(): Promise<TranscriptStoreFixture & { readonly main: TranscriptKey }> {
    const fixture = await makeFixture();
    const sessionId = await fixture.session(fixture.workspaceA);
    return { ...fixture, main: { projectKey: fixture.workspaceA, sessionId } };
  }

  describe(label, () => {
    describe('load', () => {
      it('answers null for a key nothing was ever appended under', async () => {
        const { store, main } = await setUp();
        await expect(store.load(main)).resolves.toBeNull();
        await expect(store.load({ ...main, subpath: SUBAGENT })).resolves.toBeNull();
      });

      it('distinguishes an unknown session (null) from an empty one ([])', async () => {
        const { store, main, workspaceA, session } = await setUp();
        await store.append(main, []);
        // The SDK resumes the second and not the first, so collapsing them would turn "no turns
        // yet" into "no such session".
        await expect(store.load(main)).resolves.toEqual([]);
        const other = await session(workspaceA);
        await expect(store.load({ projectKey: workspaceA, sessionId: other })).resolves.toBeNull();
      });

      it('returns entries deep-equal to what was appended, in append order', async () => {
        const { store, main } = await setUp();
        const batch = [
          entry('user', { uuid: 'a', message: { role: 'user', content: 'hello' } }),
          entry('assistant', {
            uuid: 'b',
            message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
            usage: { input_tokens: 3, ratio: 0.25, flag: true, none: null },
          }),
          entry('ai-title'),
        ];
        await store.append(main, batch);
        await store.append(main, [entry('user', { uuid: 'c' })]);
        // R-01 §7: "load() must return entries deep-equal to what was appended; byte equality is
        // not required". Nested objects included — an adapter that stringified them would pass a
        // shallow check and lose the conversation's content.
        await expect(store.load(main)).resolves.toEqual([...batch, entry('user', { uuid: 'c' })]);
      });

      it('hands out a copy, so mutating a loaded transcript cannot rewrite history', async () => {
        const { store, main } = await setUp();
        await store.append(main, [entry('user', { uuid: 'a' })]);
        const loaded = await store.load(main);
        loaded?.push(entry('forged'));
        await expect(store.load(main)).resolves.toEqual([entry('user', { uuid: 'a' })]);
      });
    });

    describe('append', () => {
      it('upserts on entry.uuid, in place, so an SDK retry cannot duplicate or reorder a turn', async () => {
        const { store, main } = await setUp();
        await store.append(main, [
          entry('user', { uuid: 'a', text: 'first' }),
          entry('assistant', { uuid: 'b' }),
        ]);
        await store.append(main, [entry('user', { uuid: 'a', text: 'corrected' })]);
        // R-01 §7: "Retries can redeliver, so append() must upsert on entry.uuid." In place,
        // because the transcript is a chain: moving the redelivered entry to the end would
        // reorder the turn.
        await expect(store.load(main)).resolves.toEqual([
          entry('user', { uuid: 'a', text: 'corrected' }),
          entry('assistant', { uuid: 'b' }),
        ]);
      });

      it('upserts the last redelivery of a uuid within one batch', async () => {
        const { store, main } = await setUp();
        await store.append(main, [
          entry('user', { uuid: 'a', text: 'one' }),
          entry('assistant', { uuid: 'b' }),
          entry('user', { uuid: 'a', text: 'two' }),
        ]);
        await expect(store.load(main)).resolves.toEqual([
          entry('user', { uuid: 'a', text: 'two' }),
          entry('assistant', { uuid: 'b' }),
        ]);
      });

      it.each([
        ['a NUL character', { message: { content: [{ text: 'a\u0000b' }] } }],
        ['a NUL character in a key', { meta: { 'a\u0000b': 1 } }],
        ['a lone surrogate', { message: { content: 'a\ud800b' } }],
      ])(
        'refuses a batch carrying %s, which PostgreSQL cannot store, and keeps none of it',
        async (_name, extra) => {
          const { store, main } = await setUp();
          await expect(
            store.append(main, [entry('user', { uuid: 'fine' }), entry('user', extra)]),
          ).rejects.toThrow();
          // All or nothing: half a batch is a transcript the SDK never wrote.
          await expect(store.load(main)).resolves.toBeNull();
        },
      );

      it('stores a well-formed surrogate pair and the escaped text of a NUL verbatim', async () => {
        const { store, main } = await setUp();
        const batch = [entry('user', { uuid: 'ok', text: '😀 \\u0000 literal' })];
        await store.append(main, batch);
        await expect(store.load(main)).resolves.toEqual(batch);
      });

      it('appends uuid-less entries without dedup', async () => {
        const { store, main } = await setUp();
        await store.append(main, [entry('ai-title'), entry('ai-title')]);
        await store.append(main, [entry('ai-title')]);
        // R-01 §7: "Entries without a uuid (titles, tags, mode markers) are appended without
        // dedup."
        await expect(store.load(main)).resolves.toHaveLength(3);
      });

      it('keeps concurrent appends for one key from overwriting each other', async () => {
        const { store, main } = await setUp();
        const batches = Array.from({ length: 12 }, (_, index) => [
          entry('user', { uuid: `u${String(index)}` }),
        ]);
        await Promise.all(batches.map((batch) => store.append(main, batch)));
        const loaded = await store.load(main);
        // Both backends are read-modify-write, so without per-key serialisation this is a lost
        // update and the length is smaller than 12. The ORDER is not asserted: the SDK's rule is
        // "within a single process, persist entries in append-call order", and Promise.all makes
        // no call order to preserve.
        expect(loaded).toHaveLength(12);
        expect(new Set(loaded?.map((one) => one.uuid))).toEqual(
          new Set(batches.map((_, index) => `u${String(index)}`)),
        );
      });

      it('keys a subpath separately from the main transcript', async () => {
        const { store, main } = await setUp();
        const subagent: TranscriptKey = { ...main, subpath: SUBAGENT };
        await store.append(main, [entry('user', { uuid: 'same', at: 'main' })]);
        await store.append(subagent, [entry('user', { uuid: 'same', at: 'sub' })]);
        // The same uuid under two keys is two entries: upsert is per transcript, not global.
        await expect(store.load(main)).resolves.toEqual([
          entry('user', { uuid: 'same', at: 'main' }),
        ]);
        await expect(store.load(subagent)).resolves.toEqual([
          entry('user', { uuid: 'same', at: 'sub' }),
        ]);
      });
    });

    describe('listSubkeys', () => {
      it('reports every subpath under a session, sorted, and no main transcript', async () => {
        const { store, main } = await setUp();
        await store.append(main, [entry('user')]);
        await store.append({ ...main, subpath: 'subagents/agent-8' }, [entry('user')]);
        await store.append({ ...main, subpath: SUBAGENT }, [entry('user')]);
        await expect(store.listSubkeys(main)).resolves.toEqual([SUBAGENT, 'subagents/agent-8']);
      });

      it('answers [] for a session nothing was written under', async () => {
        const { store, main } = await setUp();
        await expect(store.listSubkeys(main)).resolves.toEqual([]);
      });

      it('does not report another session’s subkeys', async () => {
        const { store, main, workspaceA, session } = await setUp();
        const other = await session(workspaceA);
        await store.append({ projectKey: workspaceA, sessionId: other, subpath: SUBAGENT }, [
          entry('user'),
        ]);
        await expect(store.listSubkeys(main)).resolves.toEqual([]);
      });
    });

    describe('delete', () => {
      it('on a main key cascades to every subkey', async () => {
        const { store, main } = await setUp();
        const subagent: TranscriptKey = { ...main, subpath: SUBAGENT };
        await store.append(main, [entry('user')]);
        await store.append(subagent, [entry('user')]);
        await store.delete(main);
        // R-01 §7: "delete(mainKey) must cascade to all subkeys".
        await expect(store.load(main)).resolves.toBeNull();
        await expect(store.load(subagent)).resolves.toBeNull();
        await expect(store.listSubkeys(main)).resolves.toEqual([]);
        await expect(store.listSessions(main.projectKey)).resolves.toEqual([]);
      });

      it('on a subkey leaves the main transcript and its siblings alone', async () => {
        const { store, main } = await setUp();
        const subagent: TranscriptKey = { ...main, subpath: SUBAGENT };
        await store.append(main, [entry('user', { uuid: 'main' })]);
        await store.append(subagent, [entry('user')]);
        await store.append({ ...main, subpath: 'subagents/agent-8' }, [entry('user')]);
        await store.delete(subagent);
        await expect(store.load(main)).resolves.toEqual([entry('user', { uuid: 'main' })]);
        await expect(store.load(subagent)).resolves.toBeNull();
        await expect(store.listSubkeys(main)).resolves.toEqual(['subagents/agent-8']);
      });

      it('leaves other sessions alone', async () => {
        const { store, main, workspaceA, session } = await setUp();
        const other: TranscriptKey = {
          projectKey: workspaceA,
          sessionId: await session(workspaceA),
        };
        await store.append(main, [entry('user')]);
        await store.append(other, [entry('user', { uuid: 'kept' })]);
        await store.delete(main);
        await expect(store.load(other)).resolves.toEqual([entry('user', { uuid: 'kept' })]);
      });

      it('is idempotent, and deleting a never-written key is not an error', async () => {
        const { store, main } = await setUp();
        await expect(store.delete(main)).resolves.toBeUndefined();
        await store.append(main, [entry('user')]);
        await expect(store.delete(main)).resolves.toBeUndefined();
        await expect(store.delete(main)).resolves.toBeUndefined();
      });

      it('lets a deleted key be written again, starting from nothing', async () => {
        const { store, main } = await setUp();
        await store.append(main, [entry('user', { uuid: 'old' })]);
        await store.delete(main);
        await store.append(main, [entry('user', { uuid: 'new' })]);
        await expect(store.load(main)).resolves.toEqual([entry('user', { uuid: 'new' })]);
      });
    });

    describe('listSessions', () => {
      it('reports main transcripts under the tenant key, with integer epoch-ms mtimes', async () => {
        const { store, main, workspaceA, session } = await setUp();
        const other = await session(workspaceA);
        await store.append(main, [entry('user')]);
        await store.append({ projectKey: workspaceA, sessionId: other }, []);
        await store.append({ ...main, subpath: SUBAGENT }, [entry('user')]);
        const listing = await store.listSessions(workspaceA);
        // Only main transcripts are sessions; an empty one is still one.
        expect(listing.map((one) => one.sessionId).sort()).toEqual([main.sessionId, other].sort());
        for (const one of listing) {
          // R-01 §7: "mtime = integer epoch ms".
          expect(Number.isInteger(one.mtime)).toBe(true);
          expect(one.mtime).toBeGreaterThan(0);
        }
      });

      it('orders most recently written first, and a later append moves a session up', async () => {
        const { store, workspaceA, session } = await setUp();
        const first = await session(workspaceA);
        const second = await session(workspaceA);
        const third = await session(workspaceA);
        const key = (sessionId: string): TranscriptKey => ({ projectKey: workspaceA, sessionId });
        const order = async (): Promise<string[]> =>
          (await store.listSessions(workspaceA)).map((one) => one.sessionId);
        await store.append(key(first), [entry('user')]);
        await store.append(key(second), [entry('user')]);
        await store.append(key(third), [entry('user')]);
        await expect(order()).resolves.toEqual([third, second, first]);
        // An empty batch is still a write: it moves the session up like any other append.
        await store.append(key(first), []);
        await expect(order()).resolves.toEqual([first, third, second]);
        const listing = await store.listSessions(workspaceA);
        expect(listing[0]?.mtime).toBeGreaterThanOrEqual(listing[1]?.mtime ?? Infinity);
      });

      it('answers [] for a tenant that has written nothing', async () => {
        const { store, workspaceB } = await setUp();
        await expect(store.listSessions(workspaceB)).resolves.toEqual([]);
      });
    });

    describe('workspace isolation (spec §25)', () => {
      it('listSessions() never reports another tenant’s session', async () => {
        const { store, main, workspaceA, workspaceB, session } = await setUp();
        const theirs = await session(workspaceB);
        await store.append(main, [entry('user')]);
        await store.append({ projectKey: workspaceB, sessionId: theirs }, [entry('user')]);
        await expect(store.listSessions(workspaceA)).resolves.toEqual([
          expect.objectContaining({ sessionId: main.sessionId }),
        ]);
        await expect(store.listSessions(workspaceB)).resolves.toEqual([
          expect.objectContaining({ sessionId: theirs }),
        ]);
      });

      it('scopes a session id by its projectKey: another tenant can neither read it nor learn it exists', async () => {
        const { store, main, workspaceB } = await setUp();
        await store.append(main, [entry('user', { uuid: 'ours' })]);
        await store.append({ ...main, subpath: SUBAGENT }, [entry('user')]);
        const asB: TranscriptKey = { projectKey: workspaceB, sessionId: main.sessionId };
        // The SAME session id under another tenant key answers exactly what a never-written key
        // answers, so the answer does not tell B that A has the session.
        await expect(store.load(asB)).resolves.toBeNull();
        await expect(store.load({ ...asB, subpath: SUBAGENT })).resolves.toBeNull();
        await expect(store.listSubkeys(asB)).resolves.toEqual([]);
      });

      it('leaves the transcript alone when another tenant deletes the same session id', async () => {
        const { store, main, workspaceB } = await setUp();
        await store.append(main, [entry('user', { uuid: 'ours' })]);
        await store.append({ ...main, subpath: SUBAGENT }, [entry('user')]);
        await store.delete({ projectKey: workspaceB, sessionId: main.sessionId });
        await store.delete({
          projectKey: workspaceB,
          sessionId: main.sessionId,
          subpath: SUBAGENT,
        });
        await expect(store.load(main)).resolves.toEqual([entry('user', { uuid: 'ours' })]);
        await expect(store.listSubkeys(main)).resolves.toEqual([SUBAGENT]);
      });
    });
  });
}

// ── Implementation 1: memory ────────────────────────────────────────────────────────────────

describeTranscriptStoreConformance(
  'InMemoryTranscriptStore — the SessionStore contract (R-01 §7)',
  () => {
    // A strictly increasing clock, so "most recently written first" is decided by write order and
    // not by two writes landing in the same millisecond.
    let now = Date.UTC(2026, 0, 1);
    return Promise.resolve({
      store: new InMemoryTranscriptStore(() => (now += 1)),
      workspaceA: crypto.randomUUID(),
      workspaceB: crypto.randomUUID(),
      session: () => Promise.resolve(crypto.randomUUID()),
    });
  },
);

describe('mergeTranscriptEntries — the rule both backends share', () => {
  it('is the identity on an empty batch', () => {
    const existing = [entry('user', { uuid: 'a' })];
    expect(mergeTranscriptEntries(existing, [])).toEqual(existing);
  });

  it('upserts the last redelivery of a uuid within one batch', () => {
    const merged = mergeTranscriptEntries(
      [],
      [entry('user', { uuid: 'a', text: 'one' }), entry('user', { uuid: 'a', text: 'two' })],
    );
    expect(merged).toEqual([entry('user', { uuid: 'a', text: 'two' })]);
  });
});

describe('parsing — every rejection is by name, and the last arm rejects (ADR-0015)', () => {
  it('accepts a workspace id as a projectKey', () => {
    expect(parseProjectKey('c8b1f0de-6a2e-4a1f-9d3b-000000000001')).toEqual({
      ok: true,
      value: 'c8b1f0de-6a2e-4a1f-9d3b-000000000001',
    });
  });

  it.each([
    ['a value the SDK would silently replace', 'tenant a'],
    ['an empty key', ''],
    ['a 65-character key', 'x'.repeat(65)],
    ['a path separator', 'a/b'],
    ['a traversal', '..'],
  ])('refuses %s', (_name, value) => {
    expect(parseProjectKey(value).ok).toBe(false);
  });

  it('refuses a Windows device name, which the SDK ignores silently (R-01 §7 rule 2)', () => {
    expect(parseProjectKey('con').ok).toBe(false);
    expect(parseProjectKey('COM1').ok).toBe(false);
  });

  it('refuses a non-string projectKey rather than coercing it', () => {
    expect(parseProjectKey(42).ok).toBe(false);
    expect(parseProjectKey(null).ok).toBe(false);
    expect(parseProjectKey(undefined).ok).toBe(false);
  });

  it('requires a UUID session id, which is what `resume` takes', () => {
    expect(parseSessionId(SESSION).ok).toBe(true);
    expect(parseSessionId('not-a-uuid').ok).toBe(false);
    expect(parseSessionId(7).ok).toBe(false);
  });

  it('treats an absent subpath as the main transcript and an empty one as invalid', () => {
    expect(parseSubpath(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseSubpath(null)).toEqual({ ok: true, value: undefined });
    // R-01 §7: "EMPTY STRING IS INVALID — omit the field for the main transcript."
    expect(parseSubpath('').ok).toBe(false);
  });

  it.each([
    ['a parent segment', 'subagents/../../etc'],
    ['a leading slash', '/etc/passwd'],
    ['an absolute Windows path', 'C:/Windows'],
    ['a backslash', 'subagents\\agent-1'],
    ['a percent-encoded separator', 'subagents%2f..%2fetc'],
    ['a trailing separator', 'subagents/'],
    ['a bare dot segment', './x'],
  ])('refuses a subpath carrying %s', (_name, value) => {
    expect(parseSubpath(value).ok).toBe(false);
  });

  it('accepts the shape the SDK actually writes', () => {
    expect(parseSubpath('subagents/agent-11111111-2222-4333-8444-555555555555')).toEqual({
      ok: true,
      value: 'subagents/agent-11111111-2222-4333-8444-555555555555',
    });
  });

  it('parses a whole key and names the field that was wrong', () => {
    expect(parseTranscriptKey({ projectKey: PROJECT, sessionId: SESSION })).toEqual({
      ok: true,
      value: { projectKey: PROJECT, sessionId: SESSION },
    });
    const rejected = parseTranscriptKey({ projectKey: PROJECT, sessionId: 'nope' });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? '' : rejected.reason).toMatch(/sessionId/);
    expect(parseTranscriptKey('a string').ok).toBe(false);
    expect(parseTranscriptKey(null).ok).toBe(false);
  });

  it('stores an entry verbatim, including fields the SDK does not declare', () => {
    const parsed = parseTranscriptEntry({ type: 'user', uuid: 'a', somethingNew: { deep: 1 } });
    // R-01 §4 records that the SDK emits fields its own .d.ts does not declare. A validator that
    // dropped them would corrupt a resume, so the parser checks and keeps.
    expect(parsed).toEqual({
      ok: true,
      value: { type: 'user', uuid: 'a', somethingNew: { deep: 1 } },
    });
  });

  it('refuses a deeply nested entry instead of overflowing the stack', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10_000; i += 1) nested = i % 2 === 0 ? [nested] : { n: nested };
    const parsed = parseTranscriptEntry({ type: 'user', nested });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.reason).toMatch(/nested deeper than/);
  });

  it('refuses an entry with no string type, and says which index in a batch', () => {
    expect(parseTranscriptEntry({ uuid: 'a' }).ok).toBe(false);
    expect(parseTranscriptEntry(['user']).ok).toBe(false);
    const rejected = parseTranscriptEntries([{ type: 'user' }, { uuid: 'b' }]);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? '' : rejected.reason).toMatch(/entries\[1\]/);
  });

  it('refuses, by path, an entry carrying text PostgreSQL cannot store (a 400, not a 500)', () => {
    const nul = parseTranscriptEntry({ type: 'user', message: { content: [{ text: 'a\u0000' }] } });
    expect(nul.ok ? '' : nul.reason).toMatch(/entry\.message\.content\[0\]\.text/u);
    expect(parseTranscriptEntry({ type: 'user', text: '\udc00' }).ok).toBe(false);
    expect(parseTranscriptEntry({ type: 'user', meta: { 'k\u0000': 1 } }).ok).toBe(false);
    expect(parseTranscriptEntry({ type: 'user', text: '😀' }).ok).toBe(true);
  });

  it('refuses a non-array batch and an over-long one', () => {
    expect(parseTranscriptEntries({ 0: { type: 'user' } }).ok).toBe(false);
    expect(parseTranscriptEntries(Array.from({ length: 5_001 }, () => ({ type: 'user' }))).ok).toBe(
      false,
    );
  });

  it('accepts an empty batch', () => {
    expect(parseTranscriptEntries([])).toEqual({ ok: true, value: [] });
  });
});

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[sessions/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half of ' +
      'this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed transcript store satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL transcript store', () => {
  let isolated: IsolatedTestDatabase;
  let store: TranscriptStore;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_sessions_store');
    store = new DatabaseTranscriptStore(
      createDatabaseSessionTranscriptRepositoryProvider(isolated.db),
      createDatabaseWorkspaceScopeResolver(isolated.db),
    );
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  /** A workspace with an owner and an agent, which is what a platform session hangs off. */
  async function workspace(): Promise<{ id: string; session: () => Promise<string> }> {
    const id = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id, slug: id, name: `Workspace ${id}` });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId: id,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId: id,
      name: 'Conformance agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    return {
      id,
      async session() {
        const sessionId = crypto.randomUUID();
        await isolated.db.insert(sessions).values({
          id: sessionId,
          workspaceId: id,
          userId,
          ownerPrincipalId: principalId,
          agentId,
        });
        return sessionId;
      },
    };
  }

  describeTranscriptStoreConformance('over a real PostgreSQL, against the same suite', async () => {
    const a = await workspace();
    const b = await workspace();
    return {
      store,
      workspaceA: a.id,
      workspaceB: b.id,
      session: (workspaceId) => (workspaceId === a.id ? a.session() : b.session()),
    };
  });

  it('refuses to append under a projectKey no workspace has, rather than storing it nowhere', async () => {
    // Durable-only: the in-memory store has no workspace directory to consult. Reads of such a key
    // answer like a never-written key (covered by the suite through the isolation cases).
    const absent = crypto.randomUUID();
    await expect(
      store.append({ projectKey: absent, sessionId: crypto.randomUUID() }, [entry('user')]),
    ).rejects.toThrow(/no workspace has projectKey/u);
    await expect(store.listSessions(absent)).resolves.toEqual([]);
  });
});
