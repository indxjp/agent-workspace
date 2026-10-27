/**
 * A per-key async mutex: callers with the same key run one at a time, in arrival order; different
 * keys never wait on each other. It serialises the check → write → catalog → compensation sequences
 * in `apps/web` so one request's rollback cannot delete bytes a concurrent request just wrote.
 *
 * ponytail: in-process only — it serialises requests on one instance. Across replicas (Helm HPA,
 * Cloud Run and Container Apps scale-out) the race remains; closing it needs a conditional create on
 * `ObjectStore.put` (#1258, option b).
 */
const tails = new Map<string, Promise<void>>();

const ignore = (): void => undefined;

/** Runs `fn` once every earlier call with the same `key` has settled; the lock is released even if `fn` throws. */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(ignore, ignore);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
