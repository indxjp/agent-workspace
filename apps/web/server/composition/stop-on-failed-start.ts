/**
 * What the Next.js entry does when `register()` rejects (refactoring part 03).
 *
 * Next.js keeps the rejected `register()` promise and answers every later request with it, so a
 * `next start` whose composition failed kept listening and answered 500 to every page and API call.
 * Nothing restarted it: the container stayed up, and an operator learnt about a typo in a setting
 * from users. So under `next start` and `next dev` the process now logs why and exits with status 1,
 * and the platform shows a crashed or restarting server whose log names the variable.
 *
 * `startWeb` (the embedded workspace, `aw dev`, the tests) is a library inside someone else's
 * process: it marks itself first, so the rejection is rethrown and also handed to `startWeb`,
 * which waits for the outcome and rejects with it. It has to wait: in production Next's `prepare()`
 * resolves before `register()` has run, and Next only logs a failure.
 *
 * A missing `SESSION_SECRET` or an unreachable database is not a rejection: `register()` returns,
 * and the server answers 503 with the reason (ADR W2-DB-02). That stays as it is.
 */
import { log } from '../telemetry/logger.ts';

import { defineSlot } from '../runtime-slot.ts';
import { SettingsError } from '../settings.ts';

/** How `register()` ended, for `startWeb`. */
interface EmbeddedStart {
  readonly registered: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const embedded = defineSlot<EmbeddedStart>('__agentWorkspaceEmbeddedStart__');

/**
 * Called by `startWeb` before it creates Next: a failed start then rejects, never exits. Resolves
 * once `register()` has returned and rejects with its error. Next runs `register()` once per
 * process, so a second `startWeb` in the same process gets the same outcome.
 */
export function markEmbeddedStart(): Promise<void> {
  return embedded.getOrCreate(() => {
    let resolve = (): void => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const registered = new Promise<void>((resolveRegistered, rejectRegistered) => {
      resolve = resolveRegistered;
      reject = rejectRegistered;
    });
    // `startWeb` may already have failed before it awaits this; that is not an unhandled rejection.
    registered.catch(() => undefined);
    return { registered, resolve, reject };
  }).registered;
}

/** How the entry leaves the process; tests pass their own. */
export interface StopDependencies {
  readonly exit: (code: number) => void;
  /** Runs `done` once everything written to stderr so far has been handed to the OS. */
  readonly flush: (done: () => void) => void;
}

const processStop: StopDependencies = {
  exit: (code) => process.exit(code),
  // Writes to a pipe are asynchronous on macOS, so exiting at once could drop the log line.
  flush: (done) => process.stderr.write('', () => done()),
};

/**
 * Await `register`. When it rejects outside `startWeb`, log the reason and exit with status 1; the
 * returned promise then never settles. Inside `startWeb`, hand the error to it and rethrow.
 */
export async function registerOrStop<T>(
  register: () => Promise<T>,
  dependencies: StopDependencies = processStop,
): Promise<T> {
  let registered: T;
  try {
    registered = await register();
  } catch (error) {
    const start = embedded.current();
    if (start !== null) {
      start.reject(error);
      throw error;
    }
    if (error instanceof SettingsError) {
      // One field per refused variable: the logger cuts a string field at 200 characters.
      log.error('[compose] start-up stopped on invalid settings; the server exits', {
        refused: error.reasons,
      });
    } else {
      log.error('[compose] start-up failed; the server exits', { error });
    }
    dependencies.flush(() => dependencies.exit(1));
    return await new Promise<never>(() => undefined);
  }
  embedded.current()?.resolve();
  return registered;
}
