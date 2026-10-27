/**
 * A process-global slot for wiring the composition root hands to route handlers.
 *
 * A Next.js route handler is a bare exported function with no request-scoped container to inject
 * into, and **Next.js compiles `instrumentation.ts` and the route handlers into separate module
 * graphs**. A module-level `let` is therefore one variable per bundle, and the composition root's
 * install call would be invisible to the routes. A property on `globalThis` is shared by every
 * bundle in one Node process, so each slot is anchored there under a fixed key. See
 * `docs/adr/W1-CP-04-run-api-is-installed-not-imported.md` for the measured finding.
 *
 * The scope this buys is exactly one process: two replicas have two runtimes, which is correct
 * because what is registered is per-process wiring. Nothing per-request is ever stored here.
 *
 * This module is the only place in `apps/web/server` allowed to touch `globalThis` for
 * module-graph state; `no-restricted-syntax` in `eslint.config.mjs` rejects a hand-anchored slot
 * anywhere else (#1260). There are no exceptions.
 */

/** Install, remove and read one `globalThis` property. */
export interface RuntimeSlot<T> {
  readonly set: (value: T) => void;
  readonly clear: () => void;
  /** The installed value, or `null` when nothing has been wired. Never throws. */
  readonly current: () => T | null;
  /** The installed value; when empty, install and return `init()`. `init` runs at most once per fill. */
  readonly getOrCreate: (init: () => T) => T;
}

/** Two calls with the same `key` share state, which is what lets separate module graphs agree. */
export function defineSlot<T>(key: `__agentWorkspace${string}__`): RuntimeSlot<T> {
  const current = (): T | null => {
    const value: unknown = Reflect.get(globalThis, key);
    return value === undefined ? null : (value as T);
  };
  return {
    set: (value) => {
      Reflect.set(globalThis, key, value);
    },
    clear: () => {
      Reflect.deleteProperty(globalThis, key);
    },
    current,
    getOrCreate: (init) => {
      const existing = current();
      if (existing !== null) return existing;
      const created = init();
      Reflect.set(globalThis, key, created);
      return created;
    },
  };
}
