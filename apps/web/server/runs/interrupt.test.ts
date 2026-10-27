/**
 * The runtime interrupt signal's deadline (issue #235, S-14).
 *
 * `POST /api/runs/:id/interrupt` awaits this signal, so an unreachable-but-connected runtime must
 * not be able to hold that request open after the durable half of the interrupt — terminal status
 * and token revocation — has already been committed. See `./interrupt.ts`'s own header.
 */
import { log as webLogger } from '../telemetry/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerLiveRun, resetLiveRuns, signalLiveRun, signalRuntimeInterrupt } from './interrupt';

const RUN = '11111111-1111-4111-8111-111111111111';
const BASE = 'http://runner:8080';

afterEach(() => {
  resetLiveRuns();
  vi.restoreAllMocks();
});

describe('signalRuntimeInterrupt', () => {
  it('gives up on a runtime that accepts the connection and never answers', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    // Nothing settles this request but its deadline: a blackholed container, in one fixture.
    const attached: { signal?: AbortSignal | null } = {};
    const doFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal ?? null;
        attached.signal = signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        });
      });

    await expect(
      signalRuntimeInterrupt(BASE, RUN, { authorization: 'Bearer runner' }, doFetch, 20),
    ).resolves.toBeUndefined();

    expect(attached.signal?.aborted).toBe(true);
    // The deadline is an upstream failure, reported rather than swallowed.
    expect(log).toHaveBeenCalledWith('[runs] interrupt-runtime failed', expect.anything());
  });

  it('reports a runner that refuses the signal, so a 409 is not logged like a delivered one', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    // §14.3: the runner answers `409 no_run_in_flight` when it is not holding the run — reachable
    // while the launcher has registered the run but has not yet posted it to the runtime.
    const doFetch: typeof globalThis.fetch = () =>
      Promise.resolve(Response.json({ error: 'no_run_in_flight' }, { status: 409 }));

    await expect(
      signalRuntimeInterrupt(BASE, RUN, { authorization: 'Bearer runner' }, doFetch),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith('[runs] interrupt-runtime failed', expect.anything());
  });

  it('carries the deadline on the registry path a served interrupt takes', async () => {
    registerLiveRun(RUN, { base: BASE, headers: { authorization: 'Bearer runner' } });
    const attached: { signal?: AbortSignal | null } = {};

    await signalLiveRun(RUN, (_input, init) => {
      attached.signal = init?.signal ?? null;
      return Promise.resolve(Response.json({}, { status: 202 }));
    });

    expect(attached.signal).toBeInstanceOf(AbortSignal);
    // A runtime that answers is not aborted by its own deadline.
    expect(attached.signal?.aborted).toBe(false);
  });
});
