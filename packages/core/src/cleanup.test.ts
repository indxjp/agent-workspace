import { describe, expect, it, vi } from 'vitest';

import { withCleanup, withCompensation } from './cleanup.js';

const primary = new Error('readiness timed out');
const cleanupFailure = new Error('docker rm failed');

describe('withCleanup', () => {
  it('runs the cleanup after a body that succeeds and returns its value', async () => {
    const cleanup = vi.fn(() => Promise.resolve());
    await expect(withCleanup(() => Promise.resolve(42), cleanup)).resolves.toBe(42);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('throws the cleanup failure when only the cleanup fails', async () => {
    await expect(
      withCleanup(
        () => Promise.resolve(42),
        () => Promise.reject(cleanupFailure),
      ),
    ).rejects.toBe(cleanupFailure);
  });

  it('rethrows the body failure once the cleanup has run', async () => {
    const cleanup = vi.fn(() => Promise.resolve());
    await expect(withCleanup(() => Promise.reject(primary), cleanup)).rejects.toBe(primary);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps both failures, the body first, when the cleanup fails too', async () => {
    const thrown = await withCleanup(
      () => Promise.reject(primary),
      () => Promise.reject(cleanupFailure),
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([primary, cleanupFailure]);
  });
});

describe('withCompensation', () => {
  it('does not compensate a body that succeeds', async () => {
    const compensate = vi.fn(() => Promise.resolve());
    await expect(withCompensation(() => Promise.resolve('ok'), compensate)).resolves.toBe('ok');
    expect(compensate).not.toHaveBeenCalled();
  });

  it('compensates a body that fails and rethrows its failure', async () => {
    const compensate = vi.fn(() => Promise.resolve());
    await expect(withCompensation(() => Promise.reject(primary), compensate)).rejects.toBe(primary);
    expect(compensate).toHaveBeenCalledOnce();
  });

  it('keeps both failures, the body first, when the compensation fails too', async () => {
    const thrown = await withCompensation(
      () => Promise.reject(primary),
      () => Promise.reject(cleanupFailure),
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([primary, cleanupFailure]);
  });
});
