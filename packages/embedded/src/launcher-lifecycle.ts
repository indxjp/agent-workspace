import type { LauncherResources } from './launcher-contract.js';
import { type LauncherDatabaseRoot, type LocalLauncherDeps } from './launcher-contract.js';
import { createRuntimeLock } from './runtime-lock.js';
import { LocalLauncherError } from './runtime-messages.js';

/** How long a stop during the start waits for the abandoned step to hand back what it acquired. */
export const DEFAULT_STOP_GRACE_MS = 10_000;

/** Why a pending start step was abandoned: a signal or disconnect, or the startup deadline. */
export type Interruption = 'stop' | 'deadline';

/** Thrown out of a start step a stop request abandoned; it is never reported as `failed`. */
class LauncherStopped extends Error {
  constructor() {
    super('the local runtime was stopped before it started');
    this.name = 'LauncherStopped';
  }
}

function interruptionError(signal: AbortSignal): Error {
  return signal.reason === 'deadline'
    ? new LocalLauncherError('startup_timeout')
    : new LauncherStopped();
}

/** `work`, or a rejection as soon as `signal` is aborted, whichever comes first. */
export function untilInterrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(interruptionError(signal));
  let onAbort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(interruptionError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, interrupted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/** Resolves when `work` settles or `timeoutMs` passes, whichever is first; never rejects. */
export function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

export function isInterruption(error: unknown): boolean {
  return (
    error instanceof LauncherStopped ||
    (error instanceof LocalLauncherError && error.code === 'startup_timeout')
  );
}

// Revoke while the database is up, then close its connection, then stop the workspace.
async function releaseLauncherServices<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  state: LauncherResources<Directory, Root>,
  stderr: (chunk: string) => void,
): Promise<void> {
  const heldCredential = state.credential;
  state.credential = undefined;
  if (heldCredential !== undefined) {
    try {
      // `already-revoked` is a person or a later sweep having done it; `missing` is not expected.
      if ((await heldCredential.revoke()) === 'missing') {
        stderr('warning: the local credential was not found to revoke\n');
      }
    } catch {
      stderr('warning: the local credential could not be revoked\n');
    }
  }
  const heldRoot = state.root;
  state.root = undefined;
  if (heldRoot !== undefined) {
    try {
      await heldRoot.close();
    } catch {
      stderr('warning: the database connection could not be closed\n');
    }
  }
  const heldWorkspace = state.running;
  state.running = undefined;
  if (heldWorkspace !== undefined) await heldWorkspace.close();
}

export function createLauncherLifecycle<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  deps: LocalLauncherDeps<Directory, Root>,
) {
  const lock = deps.runtimeLock ?? createRuntimeLock();
  const state: LauncherResources<Directory, Root> = {
    running: undefined,
    root: undefined,
    credential: undefined,
    lockedProjectDir: undefined,
  };
  let stopping: Promise<void> | undefined;
  let forceExit: ReturnType<typeof setTimeout> | undefined;
  const releaseLock = (): void => {
    if (state.lockedProjectDir === undefined) return;
    lock.release(state.lockedProjectDir);
    state.lockedProjectDir = undefined;
  };

  // The pid file goes last, once every service has stopped, and even when one could not.
  const release = async (): Promise<void> => {
    try {
      await releaseLauncherServices(state, deps.stderr);
    } finally {
      releaseLock();
    }
  };

  const stop = (): Promise<void> => {
    // A release that hangs (a service that never closes) must not leave a runtime that ignores
    // every signal and spins: after the grace the process exits whatever is still open.
    forceExit ??= setTimeout(() => {
      deps.stderr('warning: the local runtime did not stop within the grace; exiting\n');
      releaseLock();
      deps.exit(1);
    }, deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    stopping ??= release()
      .catch(() => {
        deps.stderr('warning: the local runtime could not stop every service cleanly\n');
      })
      .then(() => {
        clearTimeout(forceExit);
        deps.exit(0);
      });
    return stopping;
  };

  return { state, lock, release, stop };
}
