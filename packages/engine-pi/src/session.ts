/**
 * pi's JSONL session tree over the platform's engine-scoped store (ENG-06, ENG-08).
 *
 * SDK-free. pi keeps a session as a JSONL file (format v3): a `session` header line, then one line
 * per entry, each with its own `id` and the `parentId` of the entry it follows — a tree, with the
 * leaf being the last entry appended. This module maps that file onto **one store stream per
 * session, one store entry per JSONL line**, verbatim: a pi line already carries the string `type`
 * an `EngineTranscriptEntry` needs, so nothing is wrapped, and the runner keys each entry by its pi
 * `id` (`apps/runner/src/session-state.ts`), so a retried append stores it once.
 *
 * | pi                                   | `EngineSessionStore`                     |
 * | ------------------------------------ | ---------------------------------------- |
 * | `SessionManager.inMemory(…, entries)`| `load` — the whole stream, header first  |
 * | a new entry (`message`, `model_change`, …) | `append` — only lines not stored yet |
 * | a fork (`parentSession` in the header) | `load` of the parent, `append` of a copy under the new id |
 *
 * `formal/AgentWorkspace/Theorems/Invariants/Pi.lean` states the round trip — export then import
 * gives back the same `id`/`parentId` tree — and `session.test.ts` replays it against a fake store.
 *
 * ## A stream this adapter did not write is refused, not repaired
 *
 * On load, the first entry must be a `session` header naming the session being resumed, and every
 * later entry must carry a fresh `id` whose `parentId` is `null` or an earlier entry's. Anything
 * else is a refusal naming what was wrong: resuming from a tree with a dangling parent would hand
 * pi a conversation it would silently truncate at the break.
 */
import {
  StoreWriteLog,
  storeDurability,
  type EngineSessionKey,
  type EngineSessionStore,
  type EngineTranscriptEntry,
  type SessionDurabilityVerdict,
} from '@agent-workspace/engine';

/** The `type` of pi's header line. */
export const PI_SESSION_HEADER_TYPE = 'session';

/** pi's session file format version this adapter reads and writes. */
export const PI_SESSION_VERSION = 3;

/** One line of a pi session file: the header or an entry. Plain data. */
export type PiFileEntry = EngineTranscriptEntry & { readonly id: string };

export type PiStreamVerdict =
  | { readonly ok: true; readonly entries: readonly PiFileEntry[] }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a loaded stream is a pi session tree for `engineSessionId`, and return it as pi lines.
 */
export function readPiStream(
  entries: readonly EngineTranscriptEntry[],
  engineSessionId: string,
): PiStreamVerdict {
  const [header, ...rest] = entries;
  if (header?.type !== PI_SESSION_HEADER_TYPE || header['id'] !== engineSessionId) {
    return {
      ok: false,
      reason: `the stream for pi session ${JSON.stringify(engineSessionId)} does not start with that session's header; refusing to resume from state this adapter did not write.`,
    };
  }
  const seen = new Set<string>([engineSessionId]);
  const lines: PiFileEntry[] = [{ ...header, id: engineSessionId }];
  for (const [index, entry] of rest.entries()) {
    const id = entry['id'];
    const parentId = entry['parentId'];
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
      return {
        ok: false,
        reason: `entry ${String(index + 1)} of pi session ${JSON.stringify(engineSessionId)} has no id of its own.`,
      };
    }
    if (parentId !== null && (typeof parentId !== 'string' || !seen.has(parentId))) {
      return {
        ok: false,
        reason: `entry ${JSON.stringify(id)} of pi session ${JSON.stringify(engineSessionId)} follows ${JSON.stringify(parentId)}, which is not an earlier entry of the session.`,
      };
    }
    seen.add(id);
    lines.push({ ...entry, id });
  }
  return { ok: true, entries: lines };
}

/**
 * The lines of a fork: the parent's entries, unchanged, under a new header that names the parent.
 * pi's own `SessionManager.forkFrom` does the same to a file.
 */
export function forkPiStream(
  parent: readonly PiFileEntry[],
  fork: {
    readonly engineSessionId: string;
    readonly parentSessionId: string;
    readonly cwd: string;
    readonly timestamp: string;
  },
): readonly PiFileEntry[] {
  const header: PiFileEntry = {
    type: PI_SESSION_HEADER_TYPE,
    version: PI_SESSION_VERSION,
    id: fork.engineSessionId,
    timestamp: fork.timestamp,
    cwd: fork.cwd,
    parentSession: fork.parentSessionId,
  };
  return [header, ...parent.slice(1)];
}

/**
 * One session's lines, mirrored into its store stream.
 *
 * {@link persist} is handed the whole file (header and entries) whenever pi may have added to it,
 * and appends exactly the lines the stream does not hold yet, in file order. Every write is counted
 * when it resolves and recorded when it rejects; the rejection is re-thrown, so a run whose state
 * could not be stored ends with that error rather than reporting itself durable.
 */
export class PiSessionMirror {
  readonly #store: EngineSessionStore;
  readonly #key: EngineSessionKey;
  readonly #stored = new Set<string>();
  readonly #log = new StoreWriteLog();

  constructor(store: EngineSessionStore, key: EngineSessionKey) {
    this.#store = store;
    this.#key = key;
  }

  /** The stream as stored, checked. `null` when the store holds nothing for this session. */
  async load(): Promise<PiStreamVerdict | null> {
    const loaded = await this.#store.load(this.#key);
    if (loaded === null || loaded.length === 0) return null;
    const verdict = readPiStream(loaded, this.#key.sessionId);
    if (verdict.ok) for (const line of verdict.entries) this.#stored.add(line.id);
    return verdict;
  }

  /** Append the lines of `file` this stream does not hold yet. */
  async persist(file: readonly PiFileEntry[]): Promise<void> {
    const pending = file.filter((line) => !this.#stored.has(line.id));
    if (pending.length === 0) return;
    await this.#log.track(() => this.#store.append(this.#key, pending));
    for (const line of pending) this.#stored.add(line.id);
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

/** Read another session's stream — the parent of a fork — without mirroring into it. */
export async function loadPiStream(
  store: EngineSessionStore,
  key: EngineSessionKey,
): Promise<PiStreamVerdict | null> {
  const loaded = await store.load(key);
  if (loaded === null || loaded.length === 0) return null;
  return readPiStream(loaded, key.sessionId);
}

/** Every line of a session file, as `SessionManager` holds it: header first, then its entries. */
export function piFileEntries(header: unknown, entries: readonly unknown[]): PiFileEntry[] {
  const lines: PiFileEntry[] = [];
  for (const line of [header, ...entries]) {
    if (!isRecord(line) || typeof line['type'] !== 'string' || typeof line['id'] !== 'string') {
      throw new Error('pi returned a session line without a type or an id.');
    }
    lines.push({ ...line, type: line['type'], id: line['id'] });
  }
  return lines;
}

/**
 * The port's durability verdict for one run (spec §14.9). `true` only when a store was supplied,
 * the stream reached its terminal event, at least one write resolved and none failed.
 */
export function piDurability(state: {
  readonly mirror: PiSessionMirror | null;
  readonly completed: boolean;
}): SessionDurabilityVerdict {
  return storeDurability(state.mirror, state.completed);
}
