import { describe, expect, it } from 'vitest';

import {
  appendSurfaceRun,
  readSurfaceHistory,
  selectSurfaceAgent,
  SURFACE_HISTORY_RUNS_MAX,
  surfaceEntryOf,
  surfaceHistoryKey,
  surfaceHistoryStorage,
  writeSurfaceEntry,
  type SurfaceHistoryEntry,
  type SurfaceHistoryStorage,
} from './history.js';

const ENTRY: SurfaceHistoryEntry = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  resumeKey: 'k'.repeat(43),
  runIds: ['run-1'],
};
const OFFERED = ['Support triage', 'Billing'];

function memory(): SurfaceHistoryStorage {
  return surfaceHistoryStorage(false, () => {
    throw new Error('not reached');
  });
}

/** A `Storage` whose every access throws, as a blocked iframe's does. */
const THROWING = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
} satisfies SurfaceHistoryStorage;

describe('the surface history (C18, #540)', () => {
  it('round-trips an entry and the selected agent under the surface key', () => {
    const storage = memory();
    writeSurfaceEntry(storage, 'main', 'Billing', ENTRY);
    selectSurfaceAgent(storage, 'main', 'Billing');
    const history = readSurfaceHistory(storage, 'main', OFFERED);
    expect(history.agent).toBe('Billing');
    expect(surfaceEntryOf(history, 'Billing')).toEqual(ENTRY);
    expect(surfaceEntryOf(history, 'Support triage')).toBeNull();
    expect(storage.getItem(surfaceHistoryKey('main'))).not.toBeNull();

    writeSurfaceEntry(storage, 'main', 'Billing', null);
    expect(surfaceEntryOf(readSurfaceHistory(storage, 'main', OFFERED), 'Billing')).toBeNull();
    expect(readSurfaceHistory(storage, 'main', OFFERED).agent).toBe('Billing');
  });

  it('reads malformed JSON, a wrong shape or an agent no longer offered as empty', () => {
    const storage = memory();
    storage.setItem(surfaceHistoryKey('main'), '{not json');
    expect(readSurfaceHistory(storage, 'main', OFFERED)).toEqual({ agent: null, entries: {} });
    storage.setItem(
      surfaceHistoryKey('main'),
      JSON.stringify({ agent: 'Billing', entries: { Billing: { ...ENTRY, resumeKey: 'short' } } }),
    );
    expect(readSurfaceHistory(storage, 'main', OFFERED)).toEqual({ agent: null, entries: {} });
    storage.setItem(
      surfaceHistoryKey('main'),
      JSON.stringify({ agent: 'Gone', entries: { Gone: ENTRY } }),
    );
    expect(readSurfaceHistory(storage, 'main', OFFERED)).toEqual({ agent: null, entries: {} });
  });

  it('does not throw when storage refuses every access', () => {
    expect(readSurfaceHistory(THROWING, 'main', OFFERED)).toEqual({ agent: null, entries: {} });
    expect(() => {
      writeSurfaceEntry(THROWING, 'main', 'Billing', ENTRY);
      selectSurfaceAgent(THROWING, 'main', 'Billing');
      appendSurfaceRun(THROWING, 'main', 'Billing', 'run-2');
    }).not.toThrow();
  });

  it('never reaches local storage when the surface does not keep history', () => {
    let reached = 0;
    const local = (): SurfaceHistoryStorage => {
      reached += 1;
      throw new Error('not reached');
    };
    const storage = surfaceHistoryStorage(false, local);
    writeSurfaceEntry(storage, 'main', 'Billing', ENTRY);
    expect(reached).toBe(0);
    expect(surfaceEntryOf(readSurfaceHistory(storage, 'main', OFFERED), 'Billing')).toEqual(ENTRY);
  });

  it('falls back to memory when local storage cannot be reached', () => {
    const storage = surfaceHistoryStorage(true, () => {
      throw new DOMException('denied', 'SecurityError');
    });
    writeSurfaceEntry(storage, 'main', 'Billing', ENTRY);
    expect(surfaceEntryOf(readSurfaceHistory(storage, 'main', OFFERED), 'Billing')).toEqual(ENTRY);
  });

  it('keeps the last runs only, and adds none to an agent with no entry', () => {
    const storage = memory();
    writeSurfaceEntry(storage, 'main', 'Billing', { ...ENTRY, runIds: [] });
    for (let index = 0; index < SURFACE_HISTORY_RUNS_MAX + 2; index += 1) {
      appendSurfaceRun(storage, 'main', 'Billing', `run-${String(index)}`);
    }
    const runIds = surfaceEntryOf(readSurfaceHistory(storage, 'main', OFFERED), 'Billing')?.runIds;
    expect(runIds).toHaveLength(SURFACE_HISTORY_RUNS_MAX);
    expect(runIds?.[0]).toBe('run-2');
    expect(runIds?.at(-1)).toBe(`run-${String(SURFACE_HISTORY_RUNS_MAX + 1)}`);

    appendSurfaceRun(storage, 'main', 'Support triage', 'run-x');
    expect(
      surfaceEntryOf(readSurfaceHistory(storage, 'main', OFFERED), 'Support triage'),
    ).toBeNull();
  });
});
