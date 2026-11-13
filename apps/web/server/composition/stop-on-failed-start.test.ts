/**
 * Refactoring part 03: a `register()` that rejects under `next start` logs why and exits with
 * status 1, instead of leaving a server that answers 500 to every request. Under `startWeb` it
 * rethrows, and `startWeb` rejects.
 */
import { log } from '../telemetry/logger';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineSlot } from '../runtime-slot';
import { SettingsError } from '../settings';
import { markEmbeddedStart, registerOrStop, type StopDependencies } from './stop-on-failed-start';

const embedded = defineSlot<unknown>('__agentWorkspaceEmbeddedStart__');

/** Records the order of flush and exit; `flush` runs its callback at once. */
function recordingStop(): StopDependencies & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exit: (code) => calls.push(`exit ${String(code)}`),
    flush: (done) => {
      calls.push('flush');
      done();
    },
  };
}

/** Whether `promise` has settled after the microtasks queued so far have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return done;
}

afterEach(() => {
  embedded.clear();
  vi.restoreAllMocks();
});

describe('registerOrStop', () => {
  it('returns what register() returns and never exits', async () => {
    const stop = recordingStop();
    await expect(registerOrStop(() => Promise.resolve('composition'), stop)).resolves.toBe(
      'composition',
    );
    expect(stop.calls).toEqual([]);
  });

  it('logs each refused setting, flushes stderr, then exits 1, and never settles', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const stop = recordingStop();
    const reasons = [
      'AW_TRUSTED_PROXY_HOPS is "two"; expected 0 (no proxy) or the number of proxies in front of web, 1 to 16.',
      'AW_DEPLOYMENT_FEATURES is invalid: 0: Invalid option',
    ];
    const pending = registerOrStop(() => Promise.reject(new SettingsError(reasons)), stop);

    expect(await settled(pending)).toBe(false);
    expect(stop.calls).toEqual(['flush', 'exit 1']);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[compose] start-up stopped on invalid settings; the server exits',
      { refused: reasons },
    );
  });

  it('exits 1 on any other start-up failure too, logging the error', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const stop = recordingStop();
    const failure = new Error('RUNTIME_DRIVER must be one of docker, kubernetes');
    const pending = registerOrStop(() => Promise.reject(failure), stop);

    expect(await settled(pending)).toBe(false);
    expect(stop.calls).toEqual(['flush', 'exit 1']);
    expect(error).toHaveBeenCalledExactlyOnceWith('[compose] start-up failed; the server exits', {
      error: failure,
    });
  });

  it('exits only after the log line is flushed', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    let flushed: (() => void) | undefined;
    const pending = registerOrStop(() => Promise.reject(new SettingsError(['X is bad.'])), {
      exit: (code) => calls.push(`exit ${String(code)}`),
      flush: (done) => {
        flushed = done;
      },
    });
    await settled(pending);
    expect(calls).toEqual([]);
    flushed?.();
    expect(calls).toEqual(['exit 1']);
  });

  it('rethrows under startWeb and hands it the error, without logging or exiting', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const stop = recordingStop();
    const registered = markEmbeddedStart();
    const failure = new SettingsError(['AW_CONTAINER_IDLE_STOP_SECONDS is "15".']);

    await expect(registerOrStop(() => Promise.reject(failure), stop)).rejects.toBe(failure);
    await expect(registered).rejects.toBe(failure);
    expect(stop.calls).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('tells startWeb when register() has returned', async () => {
    const registered = markEmbeddedStart();
    expect(await settled(registered)).toBe(false);
    await registerOrStop(() => Promise.resolve('composition'), recordingStop());
    await expect(registered).resolves.toBeUndefined();
  });

  it('gives a second startWeb in the process the same outcome, as Next registers once', async () => {
    const first = markEmbeddedStart();
    await registerOrStop(() => Promise.resolve(undefined), recordingStop());
    expect(markEmbeddedStart()).toBe(first);
  });
});
