import { describe, expect, it } from 'vitest';

import type { DashboardSnapshot, RunSummary } from '../dashboard-wire.js';
import {
  byCurrency,
  formatSpend,
  newestFirst,
  relativeTime,
  runListsOf,
  runStatusBadge,
  runViewUrl,
  shortRunId,
} from './dashboard-model.js';
import { appStrings } from './locale.js';

const AS_OF = '2026-11-01T12:00:00.000Z';

function summary(id: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    agentId: '11111111-1111-4111-8111-111111111111',
    status: 'running',
    createdAt: AS_OF,
    durationMs: null,
    error: null,
    pendingApproval: null,
    cost: { amount: '0.000000', currency: 'USD' },
    parentRunId: null,
    ...overrides,
  };
}

const empty: DashboardSnapshot = {
  running: [],
  waiting: [],
  failed: [],
  spendToday: [],
  asOf: AS_OF,
  truncated: { running: false, waiting: false, failed: false, spend: false },
};

describe('the dashboard model', () => {
  it('orders runs newest first, then by id', () => {
    const runs = [
      summary('b', { createdAt: '2026-11-01T11:00:00.000Z' }),
      summary('c', { createdAt: '2026-11-01T11:30:00.000Z' }),
      summary('a', { createdAt: '2026-11-01T11:00:00.000Z' }),
    ];
    expect(newestFirst(runs).map((run) => run.id)).toEqual(['c', 'a', 'b']);
    expect(runs.map((run) => run.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders the spend by currency', () => {
    const spend = [
      { currency: 'USD', amount: '1', runs: 1, unsettled: 0 },
      { currency: 'EUR', amount: '2', runs: 1, unsettled: 0 },
    ];
    expect(byCurrency(spend).map((row) => row.currency)).toEqual(['EUR', 'USD']);
  });

  it('says how long ago against the snapshot’s own time, in each language', () => {
    expect(relativeTime('2026-11-01T11:59:30.000Z', AS_OF, 'en')).toBe('30 seconds ago');
    expect(relativeTime(AS_OF, AS_OF, 'en')).toBe('now');
    expect(relativeTime('2026-11-01T11:55:00.000Z', AS_OF, 'en')).toBe('5 minutes ago');
    expect(relativeTime('2026-11-01T09:10:00.000Z', AS_OF, 'en')).toBe('2 hours ago');
    expect(relativeTime('2026-10-30T12:00:00.000Z', AS_OF, 'en')).toBe('2 days ago');
    expect(relativeTime('2026-11-01T11:55:00.000Z', AS_OF, 'ja')).toBe('5 分前');
    // A clock a little ahead of the snapshot never reads as the future.
    expect(relativeTime('2026-11-01T12:00:05.000Z', AS_OF, 'en')).toBe('now');
  });

  it('gives every list its heading and its empty line, in J5’s order', () => {
    const strings = appStrings('en').dashboard;
    const lists = runListsOf(empty, strings);
    expect(lists.map((list) => list.key)).toEqual(['running', 'waiting', 'failed']);
    expect(lists.map((list) => list.empty)).toEqual([
      strings.noRunning,
      strings.noWaiting,
      strings.noFailed,
    ]);
    const filled = runListsOf(
      {
        ...empty,
        running: [summary('old', { createdAt: '2026-11-01T10:00:00.000Z' }), summary('new')],
        truncated: { ...empty.truncated, failed: true },
      },
      strings,
    );
    expect(filled[0]?.rows.map((run) => run.id)).toEqual(['new', 'old']);
    expect(filled.map((list) => list.truncated)).toEqual([false, false, true]);
  });

  it('links a run to its console view and abbreviates its id', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    expect(runViewUrl('https://aw.test/', id)).toBe(`https://aw.test/runs?run=${id}`);
    expect(runViewUrl('https://aw.test', 'a b')).toBe('https://aw.test/runs?run=a%20b');
    expect(shortRunId(id)).toBe('33333333');
  });

  it('draws a status as a badge and a spend from its exact decimal', () => {
    const strings = appStrings('en').dashboard;
    expect(runStatusBadge('awaiting_approval', strings)).toEqual({
      label: 'Awaiting approval',
      tone: 'warn',
    });
    expect(runStatusBadge('failed', strings).tone).toBe('danger');
    expect(formatSpend({ amount: '0.300000', currency: 'USD' }, 'en')).toBe('$0.30');
    expect(formatSpend({ amount: '12.345678', currency: 'USD' }, 'en')).toBe('$12.345678');
    expect(formatSpend({ amount: '1', currency: 'credits' }, 'en')).toBe('1 credits');
  });
});
