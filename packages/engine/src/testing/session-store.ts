/**
 * A fake {@link EngineSessionStore}, for scenarios about durability (ENG-04, #303).
 *
 * Three behaviours, because the durability verdict has three interesting inputs and a store that
 * only ever succeeded could not exercise two of them: it can accept, it can reject, and it can
 * hang. A run against a hanging store must report `durable: false` for "still in flight when the
 * stream ended", which is a verdict no adapter produces by accident.
 */
import type { EngineSessionKey, EngineSessionStore, EngineTranscriptEntry } from '../port.js';

export type FakeSessionStoreBehaviour = 'accept' | 'reject' | 'hang';

export type FakeSessionStore = EngineSessionStore & {
  /** Every batch this store was handed, in order, whatever the behaviour did with it. */
  appended(): readonly { key: EngineSessionKey; entries: readonly EngineTranscriptEntry[] }[];
  /**
   * The failures a real store would have recorded (ENG-06, #305).
   *
   * Declared here rather than left to the `reject` arm's rejection alone, because the durability
   * rule the platform applies is about what the **store** reports, not about what an adapter
   * happened to catch — `withStoreWriteFailures` reads this, and a fake with no answer for it could
   * not exercise the engine-neutral half of the verdict.
   */
  writeFailures(): readonly string[];
};

export function createFakeSessionStore(
  behaviour: FakeSessionStoreBehaviour = 'accept',
): FakeSessionStore {
  const batches: { key: EngineSessionKey; entries: readonly EngineTranscriptEntry[] }[] = [];
  const failures: string[] = [];
  return {
    appended: () => [...batches],
    writeFailures: () => [...failures],
    append(key, entries) {
      batches.push({ key, entries: [...entries] });
      if (behaviour === 'reject') {
        const reason = 'the fake session store was asked to reject this batch';
        failures.push(reason);
        return Promise.reject(new Error(reason));
      }
      // A promise that never settles is the point of this arm; the caller's own stream ending is
      // what ends the run, and the durability verdict is then asked about a write in flight.
      if (behaviour === 'hang') return new Promise<void>(() => undefined);
      return Promise.resolve();
    },
    load(key) {
      const found = batches.filter(
        (batch) => batch.key.projectKey === key.projectKey && batch.key.sessionId === key.sessionId,
      );
      if (found.length === 0) return Promise.resolve(null);
      return Promise.resolve(found.flatMap((batch) => [...batch.entries]));
    },
  };
}
