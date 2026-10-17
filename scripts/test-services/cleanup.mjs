import { TestServicesError } from './errors.mjs';

/**
 * A last-in, first-out list of cleanup steps that runs once.
 *
 * Register a step in the same synchronous turn as the thing it undoes, before it is created (a
 * container name before `docker run`, a child before `spawn`): a signal handler can then never run
 * the cleanup between the two, and a step whose subject was never created must simply do nothing.
 * Once `run()` has started, `add()` refuses, so nothing new is started after cleanup began.
 *
 * `run()` keeps going past a failing step and resolves with every failure, so one stuck service
 * cannot hide another left running.
 */
export function createCleanup() {
  /** @type {{ label: string; step: () => unknown }[]} */
  const steps = [];
  /** @type {Promise<{ label: string; error: unknown }[]> | undefined} */
  let running;

  return {
    /**
     * @param {string} label
     * @param {() => unknown} step
     */
    add(label, step) {
      if (running !== undefined) {
        throw new TestServicesError(
          'test_services_interrupted',
          `The test services are already being cleaned up; refusing to start ${label}.`,
        );
      }
      steps.push({ label, step });
    },
    run() {
      running ??= (async () => {
        /** @type {{ label: string; error: unknown }[]} */
        const failures = [];
        for (let next = steps.pop(); next !== undefined; next = steps.pop()) {
          try {
            await next.step();
          } catch (error) {
            failures.push({ label: next.label, error });
          }
        }
        return failures;
      })();
      return running;
    },
  };
}
