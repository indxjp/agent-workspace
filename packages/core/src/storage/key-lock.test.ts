import { describe, expect, it } from 'vitest';

import { withKeyLock } from './key-lock.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('withKeyLock', () => {
  it('never overlaps two calls on the same key and keeps arrival order', async () => {
    const events: string[] = [];
    const gate = deferred();
    const first = withKeyLock('k', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      return 1;
    });
    const second = withKeyLock('k', () => {
      events.push('second:start');
      return Promise.resolve(2);
    });
    await new Promise((done) => setTimeout(done, 5));
    expect(events).toEqual(['first:start']);

    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('lets different keys run concurrently', async () => {
    const gate = deferred();
    const blocked = withKeyLock('a', () => gate.promise);
    await expect(withKeyLock('b', () => Promise.resolve('b'))).resolves.toBe('b');
    gate.resolve();
    await blocked;
  });

  it('releases the lock and rethrows when fn throws', async () => {
    const failing = withKeyLock('k', () => Promise.reject(new Error('boom')));
    const next = withKeyLock('k', () => Promise.resolve('ran'));
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
    await expect(withKeyLock('k', () => Promise.resolve('again'))).resolves.toBe('again');
  });
});
