/**
 * The store write log and the durability verdict built on it (#951): all five arms.
 */
import { describe, expect, it } from 'vitest';

import { StoreWriteLog, storeDurability } from './session-state.js';

describe('StoreWriteLog', () => {
  it('counts the writes the store accepted', async () => {
    const log = new StoreWriteLog();
    await log.track(() => Promise.resolve());
    await log.track(() => Promise.resolve());
    expect(log.writes()).toBe(2);
    expect(log.failures()).toEqual([]);
  });

  it('records a refused write and re-throws it', async () => {
    const log = new StoreWriteLog();
    await expect(log.track(() => Promise.reject(new Error('disk full')))).rejects.toThrow(
      'disk full',
    );
    await expect(log.track(() => Promise.reject(new Error('quota')))).rejects.toThrow('quota');
    expect(log.writes()).toBe(0);
    expect(log.failures()).toEqual(['disk full', 'quota']);
  });
});

describe('storeDurability', () => {
  const record = (writes: number, failures: readonly string[] = []) => ({
    writes: () => writes,
    failures: () => failures,
  });

  it('is not durable without a store', () => {
    expect(storeDurability(null, true)).toEqual({
      durable: false,
      reason:
        'no session store was supplied, so this session exists only inside the sandbox (spec §14.9).',
    });
  });

  it('is not durable before the terminal event', () => {
    expect(storeDurability(record(1), false)).toEqual({
      durable: false,
      reason: 'the run stream has not reached its terminal event.',
    });
  });

  it('is not durable after a failed write', () => {
    expect(storeDurability(record(1, ['boom', 'later']), true)).toEqual({
      durable: false,
      reason: '2 session write(s) failed; first: boom',
    });
  });

  it('is not durable when the store accepted nothing', () => {
    expect(storeDurability(record(0), true)).toEqual({
      durable: false,
      reason: 'the session store accepted no write for this run.',
    });
  });

  it('is durable once a write resolved and none failed', () => {
    expect(storeDurability(record(3), true)).toEqual({ durable: true, mirroredBatches: 3 });
  });
});
