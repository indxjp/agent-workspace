import type { RuntimeConfig, RuntimeHandle } from '@agent-workspace/runtime/driver';

import { RunnerShuttingDownError, type ManagedRuntimeDriver } from './manager-support.js';

/** A driver that refuses new creates once {@link ShutdownGate.close} is called. */
export type ShutdownGate = Readonly<{
  driver: ManagedRuntimeDriver;
  /**
   * Refuse every later `create`, then wait at most `timeoutMs` for the creates already in flight
   * to settle. Resolves `true` when every one settled in time, `false` otherwise.
   */
  close(timeoutMs: number): Promise<boolean>;
}>;

/**
 * Close the race between a shutdown's reap and a `create` already in flight (#406 follow-up).
 *
 * A reap lists the sandboxes that exist when it runs. A `create` that started before the shutdown
 * and finishes after that listing would start a sandbox nothing removes, and it would keep the
 * project's runtime-control network alive after `docker compose down`. Through this gate, a create
 * asked for after `close` never reaches the driver, and `close` waits for the creates already in
 * flight. A create that finishes after the gate closed destroys its sandbox at once and fails
 * with {@link RunnerShuttingDownError}; if that destroy fails, it names the container on stderr.
 * The reap that follows `close` covers only the creates that settled before it ran: one that
 * outlasts `close`'s wait may still start a sandbox after the reap, or after the process has
 * exited, which is why the shutdown then reports `sandboxes-left`.
 */
export function createShutdownGate(driver: ManagedRuntimeDriver): ShutdownGate {
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();

  async function create(config: RuntimeConfig, credential?: string): Promise<RuntimeHandle> {
    const handle = await driver.create(config, credential);
    if (!closed) return handle;
    await driver.destroy(handle, credential).catch((error: unknown) => {
      process.stderr.write(
        `runner manager: could not remove ${handle.externalId}, started during shutdown: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    throw new RunnerShuttingDownError();
  }

  return {
    driver: {
      create(config, credential) {
        if (closed) return Promise.reject(new RunnerShuttingDownError());
        const pending = create(config, credential);
        const tracked = pending.then(
          () => undefined,
          () => undefined,
        );
        inFlight.add(tracked);
        void tracked.then(() => inFlight.delete(tracked));
        return pending;
      },
      destroy: (runtime, credential) => driver.destroy(runtime, credential),
      isLive: (runtime) => driver.isLive(runtime),
      ...(driver.assertCreatable === undefined
        ? {}
        : { assertCreatable: driver.assertCreatable.bind(driver) }),
      ...(driver.find === undefined ? {} : { find: driver.find.bind(driver) }),
      ...(driver.recover === undefined ? {} : { recover: driver.recover.bind(driver) }),
      ...(driver.capabilities === undefined ? {} : { capabilities: driver.capabilities }),
    },
    async close(timeoutMs) {
      closed = true;
      if (inFlight.size === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      });
      const settled = Promise.all([...inFlight]).then(() => true as const);
      try {
        return await Promise.race([settled, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
