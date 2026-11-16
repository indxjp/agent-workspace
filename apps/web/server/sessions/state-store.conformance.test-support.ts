import { describe, expect, it } from 'vitest';
import { type SessionStateStore, type SessionStateStreamRef } from './state';
import { SESSION_STATE_PAGE_LIMIT } from './store';

interface SessionStateStoreFixture {
  readonly store: SessionStateStore;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** A new platform session in `workspaceId` (the durable store's rows hang off a `sessions` row). */
  readonly session: (workspaceId: string) => Promise<string>;
}
export type MakeSessionStateStoreFixture = () => Promise<SessionStateStoreFixture>;
const ENGINE = 'claude-agent-sdk';
async function setUp(makeFixture: MakeSessionStateStoreFixture) {
  const fixture = await makeFixture();
  const sessionId = await fixture.session(fixture.workspaceA);
  const at = (streamKey: string, engine: SessionStateStreamRef['engine'] = ENGINE) =>
    ({ workspaceId: fixture.workspaceA, sessionId, engine, streamKey }) as const;
  return { ...fixture, sessionId, ref: at(`${fixture.workspaceA}/`), at };
}
type SetUp = () => ReturnType<typeof setUp>;
function registerAppendTests(setUp: SetUp) {
  it('tells an empty stream apart from one that was never written', async () => {
    // The distinction a resume turns on: `[]` says the session exists and has no turns yet, `null`
    // says nothing was ever stored, and only the first resumes.
    const { store, ref } = await setUp();
    await expect(store.list(ref, {})).resolves.toBeNull();
    await store.append(ref, []);
    await expect(store.list(ref, {})).resolves.toEqual([]);
  });
  it('upserts on entryKey in place, so a redelivery never reorders the stream', async () => {
    const { store, ref } = await setUp();
    await store.append(ref, [
      { entryKey: 'a', entry: { index: 0 } },
      { entryKey: 'b', entry: { index: 1 } },
    ]);
    await store.append(ref, [{ entryKey: 'a', entry: { index: 'corrected' } }]);
    await expect(store.list(ref, {})).resolves.toEqual([
      { sequence: 1, entryKey: 'a', entry: { index: 'corrected' } },
      { sequence: 2, entryKey: 'b', entry: { index: 1 } },
    ]);
  });
  it('appends every keyless entry, because one with no identity cannot be deduped', async () => {
    const { store, ref } = await setUp();
    await store.append(ref, [{ entry: { type: 'summary' } }]);
    await store.append(ref, [{ entry: { type: 'summary' } }]);
    await expect(store.list(ref, {})).resolves.toEqual([
      { sequence: 1, entryKey: null, entry: { type: 'summary' } },
      { sequence: 2, entryKey: null, entry: { type: 'summary' } },
    ]);
  });
  it('returns entries in append order, deep-equal to what was appended', async () => {
    const { store, ref } = await setUp();
    const entry = { usage: { n: 3, ratio: 0.25, flag: true, none: null }, list: [1, 'x'] };
    await store.append(ref, [{ entryKey: 'z', entry }]);
    await store.append(ref, [{ entryKey: 'a', entry: {} }]);
    const listed = await store.list(ref, {});
    expect(listed?.map((one) => one.entryKey)).toEqual(['z', 'a']);
    expect(listed?.[0]?.entry).toEqual(entry);
  });
}
function registerReplacementTests(setUp: SetUp) {
  it('numbers a stream densely from 1, and renumbers on replace-all', async () => {
    const { store, ref } = await setUp();
    await store.append(ref, [
      { entryKey: 'a', entry: {} },
      { entryKey: 'b', entry: {} },
    ]);
    await store.replaceAll(ref, [{ entryKey: 'z', entry: {} }]);
    await expect(store.list(ref, {})).resolves.toEqual([{ sequence: 1, entryKey: 'z', entry: {} }]);
  });
  it('creates the stream on replace-all, even with nothing to put in it', async () => {
    const { store, ref } = await setUp();
    await store.replaceAll(ref, []);
    await expect(store.list(ref, {})).resolves.toEqual([]);
  });
}
function registerDeleteLastTests(setUp: SetUp) {
  it('removes exactly the last entry, and reports an empty or unknown stream as zero', async () => {
    const { store, ref, at } = await setUp();
    await expect(store.deleteLast(at('never-written'))).resolves.toBe(0);
    await store.append(ref, [
      { entryKey: 'a', entry: {} },
      { entryKey: 'b', entry: {} },
    ]);
    await expect(store.deleteLast(ref)).resolves.toBe(1);
    await expect(store.list(ref, {})).resolves.toEqual([{ sequence: 1, entryKey: 'a', entry: {} }]);
    await expect(store.deleteLast(ref)).resolves.toBe(1);
    await expect(store.deleteLast(ref)).resolves.toBe(0);
    // Emptied is not deleted.
    await expect(store.list(ref, {})).resolves.toEqual([]);
  });
  it('keeps sequences dense when an append follows a deleteLast', async () => {
    const { store, ref } = await setUp();
    await store.append(ref, [
      { entryKey: 'a', entry: {} },
      { entryKey: 'b', entry: {} },
    ]);
    await store.deleteLast(ref);
    await store.append(ref, [{ entryKey: 'c', entry: {} }]);
    const listed = await store.list(ref, {});
    expect(listed?.map((one) => [one.sequence, one.entryKey])).toEqual([
      [1, 'a'],
      [2, 'c'],
    ]);
  });
}
function registerPagingTests(setUp: SetUp) {
  describe('paging', () => {
    it('pages from a cursor', async () => {
      const { store, ref } = await setUp();
      await store.append(ref, [
        { entryKey: 'a', entry: {} },
        { entryKey: 'b', entry: {} },
        { entryKey: 'c', entry: {} },
      ]);
      await expect(store.list(ref, { afterSequence: 1, limit: 1 })).resolves.toEqual([
        { sequence: 2, entryKey: 'b', entry: {} },
      ]);
      await expect(store.list(ref, { afterSequence: 3 })).resolves.toEqual([]);
    });

    it('caps a page at SESSION_STATE_PAGE_LIMIT, whether or not a larger limit is asked for', async () => {
      const { store, ref } = await setUp();
      const total = SESSION_STATE_PAGE_LIMIT + 3;
      await store.append(
        ref,
        Array.from({ length: total }, (_, index) => ({
          entryKey: `k${String(index)}`,
          entry: {},
        })),
      );
      await expect(store.list(ref, {})).resolves.toHaveLength(SESSION_STATE_PAGE_LIMIT);
      await expect(store.list(ref, { limit: SESSION_STATE_PAGE_LIMIT * 5 })).resolves.toHaveLength(
        SESSION_STATE_PAGE_LIMIT,
      );
      // The cursor continues exactly where the capped page stopped.
      const rest = await store.list(ref, { afterSequence: SESSION_STATE_PAGE_LIMIT });
      expect(rest?.map((one) => one.sequence)).toEqual([total - 2, total - 1, total]);
    });
  });
}
function registerStreamsTests(setUp: SetUp) {
  it('deleting a stream is not the same as emptying it, and is idempotent', async () => {
    const { store, ref, at } = await setUp();
    await store.append(ref, [{ entryKey: 'a', entry: {} }]);
    await store.deleteStream(ref);
    await expect(store.list(ref, {})).resolves.toBeNull();
    await expect(store.deleteStream(ref)).resolves.toBeUndefined();
    await expect(store.deleteStream(at('never-written'))).resolves.toBeUndefined();
  });
  it('lists a session’s streams, newest write first, and none for an unknown session', async () => {
    const { store, ref, at, workspaceA, sessionId, session } = await setUp();
    const sub = at(`${workspaceA}/subagents/agent-1`);
    await store.append(ref, []);
    await store.append(sub, []);
    const streams = await store.listStreams({ workspaceId: workspaceA, sessionId });
    expect(streams.map((stream) => stream.streamKey)).toEqual([sub.streamKey, ref.streamKey]);
    // A write moves a stream to the front.
    await store.append(ref, [{ entryKey: 'a', entry: {} }]);
    const after = await store.listStreams({ workspaceId: workspaceA, sessionId });
    expect(after.map((stream) => stream.streamKey)).toEqual([ref.streamKey, sub.streamKey]);
    const other = await session(workspaceA);
    await expect(store.listStreams({ workspaceId: workspaceA, sessionId: other })).resolves.toEqual(
      [],
    );
  });
}
function registerIsolationTests(setUp: SetUp) {
  describe('isolation', () => {
    it('keeps two streams of one session, and two engines under one key, apart', async () => {
      const { store, ref, at } = await setUp();
      const pi = at(ref.streamKey, 'pi');
      await store.append(ref, [{ entryKey: 'a', entry: { from: 'claude' } }]);
      await store.append(at('other'), [{ entryKey: 'a', entry: { from: 'other' } }]);
      await expect(store.list(pi, {})).resolves.toBeNull();
      await store.append(pi, [{ entryKey: 'a', entry: { from: 'pi' } }]);
      await expect(store.list(ref, {})).resolves.toEqual([
        { sequence: 1, entryKey: 'a', entry: { from: 'claude' } },
      ]);
      await store.deleteStream(pi);
      await expect(store.list(ref, {})).resolves.toHaveLength(1);
      await expect(store.list(at('other'), {})).resolves.toHaveLength(1);
    });

    it('never lets another workspace read, write, delete or list a stream', async () => {
      const { store, ref, sessionId, workspaceA, workspaceB } = await setUp();
      await store.append(ref, [{ entryKey: 'a', entry: { secret: true } }]);
      const asB = { ...ref, workspaceId: workspaceB };
      await expect(store.list(asB, {})).resolves.toBeNull();
      await expect(store.deleteLast(asB)).resolves.toBe(0);
      await expect(store.listStreams({ workspaceId: workspaceB, sessionId })).resolves.toEqual([]);
      await store.deleteStream(asB);
      await expect(store.list(ref, {})).resolves.toEqual([
        { sequence: 1, entryKey: 'a', entry: { secret: true } },
      ]);
      await expect(store.listStreams({ workspaceId: workspaceA, sessionId })).resolves.toHaveLength(
        1,
      );
    });
  });
}
function registerTextValidationTests(setUp: SetUp) {
  describe('text PostgreSQL cannot store', () => {
    const unstorable = [
      ['a NUL character', { message: { content: [{ text: 'a\u0000b' }] } }],
      ['a NUL character in a key', { meta: { 'a\u0000b': 1 } }],
      ['a lone surrogate', { message: { content: 'a\ud800b' } }],
    ] as const;

    it.each(unstorable)(
      'refuses an append carrying %s, and keeps none of the batch',
      async (_name, bad) => {
        const { store, ref } = await setUp();
        await expect(
          store.append(ref, [
            { entryKey: 'fine', entry: {} },
            { entryKey: 'bad', entry: bad },
          ]),
        ).rejects.toThrow();
        // All or nothing, and a refused first write does not even create the stream.
        await expect(store.list(ref, {})).resolves.toBeNull();
      },
    );

    it.each(unstorable)(
      'refuses a replace-all carrying %s, and keeps what was there',
      async (_name, bad) => {
        const { store, ref } = await setUp();
        await store.append(ref, [{ entryKey: 'kept', entry: {} }]);
        await expect(
          store.replaceAll(ref, [
            { entryKey: 'new', entry: {} },
            { entryKey: 'bad', entry: bad },
          ]),
        ).rejects.toThrow();
        await expect(store.list(ref, {})).resolves.toEqual([
          { sequence: 1, entryKey: 'kept', entry: {} },
        ]);
      },
    );

    it('stores a well-formed surrogate pair and the escaped text of a NUL verbatim', async () => {
      const { store, ref } = await setUp();
      const entry = { text: '😀 \\u0000 literal' };
      await store.append(ref, [{ entryKey: 'ok', entry }]);
      await expect(store.list(ref, {})).resolves.toEqual([{ sequence: 1, entryKey: 'ok', entry }]);
    });
  });
}
export function describeSessionStateStoreConformance(
  label: string,
  makeFixture: MakeSessionStateStoreFixture,
): void {
  describe(label, () => {
    registerAppendTests(() => setUp(makeFixture));
    registerReplacementTests(() => setUp(makeFixture));
    registerDeleteLastTests(() => setUp(makeFixture));
    registerPagingTests(() => setUp(makeFixture));
    registerStreamsTests(() => setUp(makeFixture));
    registerIsolationTests(() => setUp(makeFixture));
    registerTextValidationTests(() => setUp(makeFixture));
  });
}
