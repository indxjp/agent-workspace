/**
 * `EngineStoreSession` against a fake store: the four `Session` members are list, append,
 * delete-last and replace-all (ENG-06, ENG-09).
 */
import type { EngineSessionStore, EngineTranscriptEntry } from '@agent-workspace/engine';
import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { describe, expect, it } from 'vitest';

import { EngineStoreSession, openAiAgentsDurability } from './session.js';

const KEY = { projectKey: 'tenant-a', sessionId: 's-1' };

function listStore(): EngineSessionStore & { log: string[] } {
  let entries: EngineTranscriptEntry[] = [];
  const log: string[] = [];
  return {
    log,
    append: (_key, added) => {
      log.push('append');
      entries = [...entries, ...added];
      return Promise.resolve();
    },
    load: () => {
      log.push('load');
      return Promise.resolve(entries.length === 0 ? null : entries);
    },
    deleteLast: () => {
      log.push('deleteLast');
      entries = entries.slice(0, -1);
      return Promise.resolve();
    },
    replaceAll: (_key, replacement) => {
      log.push('replaceAll');
      entries = [...replacement];
      return Promise.resolve();
    },
  };
}

describe('EngineStoreSession', () => {
  it('maps getItems/addItems/popItem/clearSession onto load/append/deleteLast/replaceAll', async () => {
    const store = listStore();
    const session = new EngineStoreSession(store, KEY);
    expect(await session.getSessionId()).toBe('s-1');
    expect(await session.getItems()).toEqual([]);
    await session.addItems([
      { role: 'user', content: 'a' },
      { type: 'message', role: 'assistant' },
    ]);
    expect(await session.getItems()).toEqual([
      { role: 'user', content: 'a' },
      { type: 'message', role: 'assistant' },
    ]);
    expect(await session.getItems(1)).toEqual([{ type: 'message', role: 'assistant' }]);
    expect(await session.popItem()).toEqual({ type: 'message', role: 'assistant' });
    expect(await session.getItems()).toEqual([{ role: 'user', content: 'a' }]);
    await session.clearSession();
    expect(await session.getItems()).toEqual([]);
    expect(await session.popItem()).toBeUndefined();
    expect(store.log).toContain('deleteLast');
    expect(store.log).toContain('replaceAll');
    expect(session.writes()).toBe(3);
  });

  it('refuses popItem and clearSession on a store without deleteLast / replaceAll', async () => {
    const session = new EngineStoreSession(createFakeSessionStore('accept'), KEY);
    await session.addItems([{ role: 'user', content: 'a' }]);
    await expect(session.popItem()).rejects.toThrow(/deleteLast/u);
    await expect(session.clearSession()).rejects.toThrow(/replaceAll/u);
  });

  it('refuses to resume from an entry it did not write', async () => {
    const store = createFakeSessionStore('accept');
    await store.append(KEY, [{ type: 'claude-transcript-line' }]);
    await expect(new EngineStoreSession(store, KEY).getItems()).rejects.toThrow(/did not write/u);
  });

  it('is durable only when a store accepted a write and the stream completed', async () => {
    expect(openAiAgentsDurability({ session: null, completed: true }).durable).toBe(false);
    const accepting = new EngineStoreSession(createFakeSessionStore('accept'), KEY);
    expect(openAiAgentsDurability({ session: accepting, completed: true }).durable).toBe(false);
    await accepting.addItems([{ role: 'user', content: 'a' }]);
    expect(openAiAgentsDurability({ session: accepting, completed: false }).durable).toBe(false);
    expect(openAiAgentsDurability({ session: accepting, completed: true })).toEqual({
      durable: true,
      mirroredBatches: 1,
    });
    const rejecting = new EngineStoreSession(createFakeSessionStore('reject'), KEY);
    await expect(rejecting.addItems([{ role: 'user', content: 'a' }])).rejects.toThrow();
    expect(openAiAgentsDurability({ session: rejecting, completed: true }).durable).toBe(false);
  });
});
