/**
 * Mastra memory over the platform's engine-scoped store (ENG-06, ENG-10; ADR-0084 D2).
 *
 * SDK-free. Mastra keeps a conversation as a **thread** of messages in the `memory` domain of a
 * storage adapter. The runner has no database credential and must not get one, so this adapter
 * never gives Mastra a database: `./boundary.ts` hands `Memory` a storage whose only domain is
 * `memory`, backed in-process by Mastra's own in-memory domain and journalled here, entry by entry,
 * into **one store stream per thread**:
 *
 * | Mastra `MemoryStorage` call          | `EngineSessionStore`                               |
 * | ------------------------------------ | -------------------------------------------------- |
 * | `saveThread` / `updateThread`        | `append` of `{ type: 'mastra.thread', key: 'thread' }` |
 * | `saveMessages` / `updateMessages`    | `append` of one `{ type: 'mastra.message', key: 'message:<id>' }` each |
 * | the run's first read of the thread   | `load` — the whole stream, folded by `key`          |
 *
 * `key` is the entry's idempotency key (`apps/runner/src/session-state.ts` upserts on it), so a
 * message Mastra updates replaces its earlier entry rather than duplicating it, and the fold below
 * is last-writer-wins by key either way. `formal/AgentWorkspace/Theorems/Invariants/Mastra.lean`
 * states the round trip — journal then load gives back the same thread and messages — and
 * `session.test.ts` replays it against a fake store.
 *
 * ## A stream this adapter did not write is refused, not repaired
 *
 * On load, the stream must hold a thread entry for the thread being resumed, and every message
 * must be a message of that thread. Anything else is a refusal naming what was wrong: resuming
 * from somebody else's thread would hand the model a conversation it never had.
 */
import {
  StoreWriteLog,
  storeDurability,
  type EngineSessionKey,
  type EngineSessionStore,
  type EngineTranscriptEntry,
  type SessionDurabilityVerdict,
} from '@agent-workspace/engine';

/** The `type` of the entry holding the thread record. */
export const MASTRA_THREAD_ENTRY_TYPE = 'mastra.thread';
/** The `type` of an entry holding one message. */
export const MASTRA_MESSAGE_ENTRY_TYPE = 'mastra.message';
/** The idempotency key of the thread entry. A message's is `message:<id>`. */
export const MASTRA_THREAD_ENTRY_KEY = 'thread';

/** A JSON object, as stored. Dates are ISO strings in it. */
export type MastraJsonRecord = Readonly<Record<string, unknown>>;

/** One stream entry this adapter writes. */
export type MastraMemoryEntry = EngineTranscriptEntry & { readonly key: string };

/** A thread and its messages, in the order the thread first saw them. */
export type MastraThreadState = {
  readonly thread: MastraJsonRecord;
  readonly messages: readonly MastraJsonRecord[];
};

export type MastraThreadVerdict =
  | { readonly ok: true; readonly state: MastraThreadState }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is MastraJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value as JSON would carry it: Dates become ISO strings, `undefined` members disappear. */
export function asJsonRecord(value: unknown): MastraJsonRecord {
  const encoded: unknown = JSON.parse(JSON.stringify(value) ?? 'null');
  if (!isRecord(encoded)) throw new Error('a Mastra memory record did not serialise to an object.');
  return encoded;
}

/** The entry that journals a thread record. */
export function threadEntry(thread: unknown): MastraMemoryEntry {
  return {
    type: MASTRA_THREAD_ENTRY_TYPE,
    key: MASTRA_THREAD_ENTRY_KEY,
    thread: asJsonRecord(thread),
  };
}

/** The entry that journals one message. */
export function messageEntry(message: unknown): MastraMemoryEntry {
  const record = asJsonRecord(message);
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Mastra saved a message without an id, so it cannot be journalled.');
  }
  return { type: MASTRA_MESSAGE_ENTRY_TYPE, key: `message:${id}`, message: record };
}

/**
 * Fold a loaded stream into the thread it records, and check it is `threadId`'s.
 * Last writer wins per key; the order is the order each key was first written.
 */
export function readMastraThread(
  entries: readonly EngineTranscriptEntry[],
  threadId: string,
): MastraThreadVerdict {
  let thread: MastraJsonRecord | null = null;
  const messages = new Map<string, MastraJsonRecord>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type === MASTRA_THREAD_ENTRY_TYPE && isRecord(entry['thread'])) {
      thread = entry['thread'];
      continue;
    }
    const message = entry['message'];
    if (entry.type !== MASTRA_MESSAGE_ENTRY_TYPE || !isRecord(message)) {
      return {
        ok: false,
        reason: `entry ${String(index)} of Mastra thread ${JSON.stringify(threadId)} is not a thread or message entry this adapter writes.`,
      };
    }
    const id = message['id'];
    if (typeof id !== 'string' || message['threadId'] !== threadId) {
      return {
        ok: false,
        reason: `entry ${String(index)} of Mastra thread ${JSON.stringify(threadId)} holds a message of another thread; refusing to resume from state this adapter did not write.`,
      };
    }
    messages.set(id, message);
  }
  if (thread === null || thread['id'] !== threadId) {
    return {
      ok: false,
      reason: `the stream for Mastra thread ${JSON.stringify(threadId)} holds no record of that thread; refusing to resume from state this adapter did not write.`,
    };
  }
  return { ok: true, state: { thread, messages: [...messages.values()] } };
}

/**
 * One thread's memory, journalled into its store stream.
 *
 * Every write is counted when it resolves and recorded when it rejects; the rejection is re-thrown
 * to Mastra, so a run whose memory could not be stored fails rather than reporting itself durable.
 */
export class MastraMemoryJournal {
  readonly #store: EngineSessionStore;
  readonly #key: EngineSessionKey;
  readonly #log = new StoreWriteLog();

  constructor(store: EngineSessionStore, key: EngineSessionKey) {
    this.#store = store;
    this.#key = key;
  }

  /** The thread as stored, checked. `null` when the store holds nothing for it. */
  async load(): Promise<MastraThreadVerdict | null> {
    const loaded = await this.#store.load(this.#key);
    if (loaded === null || loaded.length === 0) return null;
    return readMastraThread(loaded, this.#key.sessionId);
  }

  /** Append entries to the thread's stream. */
  async record(entries: readonly MastraMemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.#log.track(() => this.#store.append(this.#key, entries));
  }

  /** Writes the store accepted. */
  writes(): number {
    return this.#log.writes();
  }

  /** Writes the store refused, in order. */
  failures(): readonly string[] {
    return this.#log.failures();
  }
}

/**
 * The port's durability verdict for one run (spec §14.9). `true` only when a store was supplied,
 * the stream reached its terminal event, at least one write resolved and none failed.
 */
export function mastraDurability(state: {
  readonly journal: MastraMemoryJournal | null;
  readonly completed: boolean;
}): SessionDurabilityVerdict {
  return storeDurability(state.journal, state.completed);
}
