/**
 * `InMemoryTranscriptStore` — the {@link TranscriptStore} that does not survive a restart, and
 * says so.
 *
 * It exists for the same reason `apps/web/server/agents/memory-store.ts` does: one contract suite
 * runs against every implementation, so the durable one cannot quietly diverge from the rule set
 * (`store.test.ts`). It is also what a unit test of the route handlers installs, because a handler
 * test that needs a filesystem is a filesystem test.
 *
 * **It is never installed by a deployment.** Spec §14.9 makes a session that lives only in a
 * process a release blocker, and `docs/adr/W2-DB-02-no-silent-memory-fallback.md` already records
 * the rule this obeys: a composition root that cannot reach durable storage installs nothing and
 * the routes answer 503, rather than falling back to memory behind the operator's back.
 *
 * Each stored transcript keeps **the key it was written under**, not a parsed form of the map's
 * string id. The id is an opaque encoding (see `transcriptKeyId`), and a listing that recovered
 * `projectKey` by splitting it would be a second, weaker parser for a value the store already has.
 */
import {
  KeyedSerialiser,
  mergeTranscriptEntries,
  transcriptKeyId,
  type TranscriptEntry,
  type TranscriptKey,
  type TranscriptSessionListing,
  type TranscriptStore,
  unstorableTextPath,
} from './transcript';

interface StoredTranscript {
  readonly key: TranscriptKey;
  entries: TranscriptEntry[];
  mtime: number;
}

export class InMemoryTranscriptStore implements TranscriptStore {
  readonly #transcripts = new Map<string, StoredTranscript>();
  readonly #serialiser = new KeyedSerialiser();
  readonly #clock: () => number;

  /** The clock is a parameter so a test can make `mtime` observable rather than merely present. */
  constructor(clock: () => number = () => Date.now()) {
    this.#clock = clock;
  }

  append(key: TranscriptKey, entries: readonly TranscriptEntry[]): Promise<void> {
    const id = transcriptKeyId(key);
    // The durable store's `jsonb` column refuses these and rolls the whole batch back; this one
    // refuses the same batch the same way, so a test against memory cannot pass an append that
    // a deployment would fail.
    const unstorable = entries
      .map((entry, index) => unstorableTextPath(entry, `entries[${String(index)}]`))
      .find((path) => path !== null);
    if (unstorable !== undefined) {
      return Promise.reject(
        new Error(`${unstorable} cannot be stored (NUL, unpaired surrogate or nesting too deep)`),
      );
    }
    return this.#serialiser.run(id, () => {
      const existing = this.#transcripts.get(id);
      this.#transcripts.set(id, {
        key,
        entries: mergeTranscriptEntries(existing?.entries ?? [], entries),
        mtime: Math.trunc(this.#clock()),
      });
      return Promise.resolve();
    });
  }

  load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    const stored = this.#transcripts.get(transcriptKeyId(key));
    // A copy, not the stored array: a caller that mutated what it was handed would rewrite
    // history in a store that is meant to be append-and-upsert only.
    return Promise.resolve(stored === undefined ? null : [...stored.entries]);
  }

  listSessions(projectKey: string): Promise<TranscriptSessionListing[]> {
    const listing: TranscriptSessionListing[] = [];
    for (const stored of this.#transcripts.values()) {
      if (stored.key.projectKey !== projectKey) continue;
      // Only main transcripts are sessions. A subkey is part of one, not another one.
      if (stored.key.subpath !== undefined) continue;
      listing.push({ sessionId: stored.key.sessionId, mtime: stored.mtime });
    }
    listing.sort(
      (left, right) => right.mtime - left.mtime || left.sessionId.localeCompare(right.sessionId),
    );
    return Promise.resolve(listing);
  }

  delete(key: TranscriptKey): Promise<void> {
    const id = transcriptKeyId(key);
    return this.#serialiser.run(id, () => {
      this.#transcripts.delete(id);
      // R-01 §7: `delete(mainKey)` cascades to every subkey. A main key is one with no subpath,
      // and the cascade is a positive act rather than something a later read happens to miss.
      if (key.subpath === undefined) {
        for (const [storedId, stored] of [...this.#transcripts]) {
          if (
            stored.key.projectKey === key.projectKey &&
            stored.key.sessionId === key.sessionId &&
            stored.key.subpath !== undefined
          ) {
            this.#transcripts.delete(storedId);
          }
        }
      }
      return Promise.resolve();
    });
  }

  listSubkeys(key: { readonly projectKey: string; readonly sessionId: string }): Promise<string[]> {
    const subpaths: string[] = [];
    for (const stored of this.#transcripts.values()) {
      if (stored.key.projectKey !== key.projectKey) continue;
      if (stored.key.sessionId !== key.sessionId) continue;
      const subpath = stored.key.subpath;
      if (subpath !== undefined) subpaths.push(subpath);
    }
    subpaths.sort();
    return Promise.resolve(subpaths);
  }
}
