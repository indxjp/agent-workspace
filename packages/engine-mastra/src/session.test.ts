/**
 * Mastra memory over the platform's store: the journal round trip, the refusal of a stream this
 * adapter did not write, and the durability verdict (ENG-10, #309; ADR-0084 D2).
 */
import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { describe, expect, it } from 'vitest';

import {
  mastraDurability,
  MastraMemoryJournal,
  messageEntry,
  readMastraThread,
  threadEntry,
} from './session.js';

const THREAD = 'thread-1';
const KEY = { projectKey: 'tenant', sessionId: THREAD };
const AT = new Date('2026-09-29T10:00:00.000Z');

const thread = { id: THREAD, resourceId: 'tenant', title: undefined, createdAt: AT, updatedAt: AT };
const message = (id: string, text: string): Record<string, unknown> => ({
  id,
  role: 'user',
  threadId: THREAD,
  resourceId: 'tenant',
  createdAt: AT,
  content: { format: 2, parts: [{ type: 'text', text }] },
});

describe('the memory journal', () => {
  it('round-trips a thread and its messages through the store, dates as ISO strings', async () => {
    const store = createFakeSessionStore('accept');
    const journal = new MastraMemoryJournal(store, KEY);
    await journal.record([threadEntry(thread)]);
    await journal.record([
      messageEntry(message('m1', 'first')),
      messageEntry(message('m2', 'second')),
    ]);
    const loaded = await new MastraMemoryJournal(store, KEY).load();
    expect(loaded).toEqual({
      ok: true,
      state: {
        thread: {
          id: THREAD,
          resourceId: 'tenant',
          createdAt: AT.toISOString(),
          updatedAt: AT.toISOString(),
        },
        messages: [
          { ...message('m1', 'first'), createdAt: AT.toISOString() },
          { ...message('m2', 'second'), createdAt: AT.toISOString() },
        ],
      },
    });
    expect(journal.writes()).toBe(2);
  });

  it('keys every entry for an idempotent upsert, so an updated message replaces its first entry', () => {
    expect(threadEntry(thread)).toMatchObject({ type: 'mastra.thread', key: 'thread' });
    expect(messageEntry(message('m1', 'x'))).toMatchObject({
      type: 'mastra.message',
      key: 'message:m1',
    });
    const folded = readMastraThread(
      [
        threadEntry(thread),
        messageEntry(message('m1', 'draft')),
        messageEntry(message('m2', 'b')),
        messageEntry(message('m1', 'final')),
      ],
      THREAD,
    );
    expect(folded.ok && folded.state.messages.map((entry) => entry['content'])).toEqual([
      { format: 2, parts: [{ type: 'text', text: 'final' }] },
      { format: 2, parts: [{ type: 'text', text: 'b' }] },
    ]);
  });

  it('answers null for a thread the store has never seen', async () => {
    await expect(
      new MastraMemoryJournal(createFakeSessionStore('accept'), KEY).load(),
    ).resolves.toBeNull();
  });

  it('refuses a stream without this thread, with a foreign message, or with an unknown entry', () => {
    expect(readMastraThread([messageEntry(message('m1', 'x'))], THREAD).ok).toBe(false);
    expect(readMastraThread([threadEntry({ ...thread, id: 'other' })], THREAD).ok).toBe(false);
    expect(
      readMastraThread(
        [threadEntry(thread), messageEntry({ ...message('m1', 'x'), threadId: 'other' })],
        THREAD,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('another thread') as unknown });
    expect(readMastraThread([threadEntry(thread), { type: 'user', uuid: 'u' }], THREAD).ok).toBe(
      false,
    );
  });

  it('refuses to journal a message with no id', () => {
    expect(() => messageEntry({ role: 'user' })).toThrow(/without an id/u);
  });

  it('records a refused write, re-throws it, and reports the run non-durable', async () => {
    const journal = new MastraMemoryJournal(createFakeSessionStore('reject'), KEY);
    await expect(journal.record([threadEntry(thread)])).rejects.toThrow();
    expect(journal.failures()).toHaveLength(1);
    expect(mastraDurability({ journal, completed: true })).toMatchObject({ durable: false });
  });
});

describe('mastraDurability', () => {
  it('is durable only with a store, a terminal event and an accepted write', async () => {
    expect(mastraDurability({ journal: null, completed: true }).durable).toBe(false);
    const journal = new MastraMemoryJournal(createFakeSessionStore('accept'), KEY);
    expect(mastraDurability({ journal, completed: true })).toMatchObject({ durable: false });
    await journal.record([threadEntry(thread)]);
    expect(mastraDurability({ journal, completed: false })).toMatchObject({ durable: false });
    expect(mastraDurability({ journal, completed: true })).toEqual({
      durable: true,
      mirroredBatches: 1,
    });
  });

  it('words each non-durable verdict in the store wording', async () => {
    expect(mastraDurability({ journal: null, completed: true })).toEqual({
      durable: false,
      reason:
        'no session store was supplied, so this session exists only inside the sandbox (spec §14.9).',
    });
    const rejecting = new MastraMemoryJournal(createFakeSessionStore('reject'), KEY);
    await expect(rejecting.record([threadEntry(thread)])).rejects.toThrow();
    expect(mastraDurability({ journal: rejecting, completed: true })).toMatchObject({
      durable: false,
      reason: expect.stringMatching(/^1 session write\(s\) failed; first: /u) as unknown,
    });
    const silent = new MastraMemoryJournal(createFakeSessionStore('accept'), KEY);
    expect(mastraDurability({ journal: silent, completed: true })).toEqual({
      durable: false,
      reason: 'the session store accepted no write for this run.',
    });
  });
});
