/**
 * pi's JSONL session tree over the engine-scoped store: the round trip, the refusals, the mirror
 * and the durability verdict (ENG-08, #307).
 */
import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { describe, expect, it } from 'vitest';

import {
  forkPiStream,
  loadPiStream,
  piDurability,
  piFileEntries,
  PiSessionMirror,
  readPiStream,
  type PiFileEntry,
} from './session.js';

const ID = 'c0ffee00-1111-4222-8333-444455556666';
const KEY = { projectKey: 'tenant', sessionId: ID };

/** A branched tree: a → b → c, and a → d (a branch from the root). */
const FILE: readonly PiFileEntry[] = [
  { type: 'session', version: 3, id: ID, timestamp: 't0', cwd: '/w' },
  {
    type: 'model_change',
    id: 'a',
    parentId: null,
    timestamp: 't1',
    provider: 'anthropic',
    modelId: 'm',
  },
  {
    type: 'message',
    id: 'b',
    parentId: 'a',
    timestamp: 't2',
    message: { role: 'user', content: 'hi' },
  },
  {
    type: 'message',
    id: 'c',
    parentId: 'b',
    timestamp: 't3',
    message: { role: 'assistant', content: [] },
  },
  {
    type: 'message',
    id: 'd',
    parentId: 'a',
    timestamp: 't4',
    message: { role: 'user', content: 'again' },
  },
];

describe('the store mirror', () => {
  it('round-trips the id/parentId tree, one entry per JSONL line, in order', async () => {
    const store = createFakeSessionStore('accept');
    const mirror = new PiSessionMirror(store, KEY);
    await mirror.persist(FILE.slice(0, 3));
    await mirror.persist(FILE);
    // Only the two lines the stream did not hold were appended the second time.
    expect(store.appended().map((batch) => batch.entries.length)).toEqual([3, 2]);

    const loaded = await new PiSessionMirror(store, KEY).load();
    expect(loaded).toEqual({ ok: true, entries: FILE });
    expect(
      loaded?.ok ? loaded.entries.map((line) => [line.id, line['parentId'] ?? null]) : [],
    ).toEqual([
      [ID, null],
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'a'],
    ]);
  });

  it('appends nothing a resumed stream already holds', async () => {
    const store = createFakeSessionStore('accept');
    await new PiSessionMirror(store, KEY).persist(FILE);
    const resumed = new PiSessionMirror(store, KEY);
    await resumed.load();
    await resumed.persist([
      ...FILE,
      {
        type: 'message',
        id: 'e',
        parentId: 'd',
        timestamp: 't5',
        message: { role: 'user', content: 'x' },
      },
    ]);
    expect(store.appended().map((batch) => batch.entries.map((line) => line['id']))).toEqual([
      [ID, 'a', 'b', 'c', 'd'],
      ['e'],
    ]);
    expect(resumed.writes()).toBe(1);
  });

  it('records and re-throws a write the store refused', async () => {
    const mirror = new PiSessionMirror(createFakeSessionStore('reject'), KEY);
    await expect(mirror.persist(FILE)).rejects.toThrow(/reject/u);
    expect(mirror.failures()).toHaveLength(1);
    expect(piDurability({ mirror, completed: true })).toMatchObject({ durable: false });
  });

  it('answers null for a session the store does not hold', async () => {
    expect(await new PiSessionMirror(createFakeSessionStore(), KEY).load()).toBeNull();
    expect(await loadPiStream(createFakeSessionStore(), KEY)).toBeNull();
  });
});

describe('readPiStream', () => {
  it.each<[string, readonly PiFileEntry[]]>([
    ['no header', FILE.slice(1)],
    ["another session's header", [{ ...FILE[0], id: 'other' } as PiFileEntry, ...FILE.slice(1)]],
    ['a repeated id', [...FILE, { type: 'label', id: 'b', parentId: 'a', timestamp: 't' }]],
    [
      'a dangling parent',
      [...FILE, { type: 'label', id: 'z', parentId: 'nowhere', timestamp: 't' }],
    ],
    [
      'a parent that comes later',
      [FILE[0] as PiFileEntry, FILE[2] as PiFileEntry, FILE[1] as PiFileEntry],
    ],
  ])('refuses a stream with %s', (_name, entries) => {
    const verdict = readPiStream(entries, ID);
    expect(verdict.ok).toBe(false);
  });
});

describe('forkPiStream', () => {
  it("copies the parent's entries under a header naming the parent", () => {
    const forked = forkPiStream(FILE, {
      engineSessionId: 'fork-id',
      parentSessionId: ID,
      cwd: '/w2',
      timestamp: 'tf',
    });
    expect(forked[0]).toEqual({
      type: 'session',
      version: 3,
      id: 'fork-id',
      timestamp: 'tf',
      cwd: '/w2',
      parentSession: ID,
    });
    expect(forked.slice(1)).toEqual(FILE.slice(1));
    expect(readPiStream(forked, 'fork-id').ok).toBe(true);
  });
});

describe('piFileEntries', () => {
  it('takes the header and the entries as pi holds them, and refuses a line without an id', () => {
    expect(piFileEntries(FILE[0], FILE.slice(1))).toEqual(FILE);
    expect(() => piFileEntries(FILE[0], [{ type: 'message' }])).toThrow(/id/u);
  });
});

describe('piDurability', () => {
  it('is a reasoned no without a store, before the end, or with no write', () => {
    expect(piDurability({ mirror: null, completed: true })).toMatchObject({ durable: false });
    const mirror = new PiSessionMirror(createFakeSessionStore(), KEY);
    expect(piDurability({ mirror, completed: false })).toMatchObject({ durable: false });
    expect(piDurability({ mirror, completed: true })).toMatchObject({ durable: false });
  });

  it('is earned by an accepted write and a completed stream', async () => {
    const mirror = new PiSessionMirror(createFakeSessionStore(), KEY);
    await mirror.persist(FILE);
    expect(piDurability({ mirror, completed: true })).toEqual({
      durable: true,
      mirroredBatches: 1,
    });
  });
});
