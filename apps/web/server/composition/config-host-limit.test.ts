import { describe, expect, it, vi } from 'vitest';

import { hostLaunchOptions, hostRunLimitMs, maximumRunDurationMs } from './config';

describe('hostRunLimitMs (issue #830, ADR-0120 LC7)', () => {
  it('is the Vercel function maximum less the interrupt margin on Vercel Functions', () => {
    expect(hostRunLimitMs({ VERCEL: '1' })).toBe(285_000);
  });

  it('is no limit anywhere else', () => {
    expect(hostRunLimitMs({})).toBeNull();
    expect(hostRunLimitMs({ VERCEL: '' })).toBeNull();
    expect(hostRunLimitMs({ VERCEL: '0' })).toBeNull();
    expect(hostRunLimitMs({ RUNTIME_DRIVER: 'aca-sessions' })).toBeNull();
  });

  it('is the Container idle stop less the interrupt margin on a Cloudflare Container (issue #831)', () => {
    expect(hostRunLimitMs({ AW_CONTAINER_IDLE_STOP_SECONDS: '900' })).toBe(885_000);
    expect(hostRunLimitMs({ VERCEL: '1', AW_CONTAINER_IDLE_STOP_SECONDS: '900' })).toBe(285_000);
  });

  it.each(['', '0', '15', '-900', '9.5', 'soon'])(
    'is no limit for the malformed idle stop %j',
    (value) => {
      expect(hostRunLimitMs({ AW_CONTAINER_IDLE_STOP_SECONDS: value })).toBeNull();
    },
  );

  it('leaves the credential-bound and ACA lifetimes exactly as they were', () => {
    expect(maximumRunDurationMs({ VERCEL: '1' }, 300)).toBe(270_000);
    expect(maximumRunDurationMs({ RUNTIME_DRIVER: 'aca-sessions' }, 300)).toBe(225_000);
  });
});

describe('hostLaunchOptions (issue #831, ADR-0127)', () => {
  it('bounds a Cloudflare Container run without keepAlive, so `after` is never called', () => {
    const after = vi.fn();
    expect(hostLaunchOptions({ AW_CONTAINER_IDLE_STOP_SECONDS: '900' }, after)).toEqual({
      hostMaxRunDurationMs: 885_000,
    });
    expect(after).not.toHaveBeenCalled();
  });

  it('bounds a Vercel run and keeps its launch alive through `after`', async () => {
    const after = vi.fn();
    const options = hostLaunchOptions({ VERCEL: '1' }, after);
    expect(options.hostMaxRunDurationMs).toBe(285_000);
    const work = Promise.resolve();
    options.keepAlive?.(work);
    expect(after).toHaveBeenCalledWith(work);
    await work;
  });

  it('adds nothing on a host without a limit', () => {
    expect(hostLaunchOptions({}, vi.fn())).toEqual({});
  });
});
