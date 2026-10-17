/**
 * The OpenAI Agents SDK's `Session`, over the platform's engine-scoped store (ENG-06, ENG-09).
 *
 * SDK-free: the class below is **structurally** the SDK's `Session` interface
 * (`getSessionId`, `getItems`, `addItems`, `popItem`, `clearSession`), and `./boundary.ts` — the
 * only file that may name the SDK's types — checks that it is assignable. The four operations
 * correspond one to one with the store's (ADR-0071 "The operations"):
 *
 * | `Session`         | `EngineSessionStore` |
 * | ----------------- | -------------------- |
 * | `getItems(limit)` | `load` (list)        |
 * | `addItems(items)` | `append`             |
 * | `popItem()`       | `deleteLast`         |
 * | `clearSession()`  | `replaceAll(key, [])`|
 *
 * `formal/AgentWorkspace/Theorems/Refinement/OpenAiAgents.lean` states that correspondence as a
 * refinement of the store's list model, and `session.test.ts` replays it against a fake store.
 *
 * ## One entry per item, wrapped
 *
 * A store entry must carry a string `type` (`EngineTranscriptEntry`), and an SDK input item may
 * not: a user message is `{ role: 'user', content }` with `type` optional. So every item is stored
 * as `{ type: 'openai-agents.item', item }` and unwrapped on the way back. The wrapper is the
 * adapter's, and the platform reads no field of it.
 *
 * ## An operation the store lacks is a refusal, not a no-op
 *
 * `deleteLast` and `replaceAll` are optional on the port. A store without one answers the SDK's
 * `popItem` / `clearSession` with a thrown error that names the missing operation — the port's
 * rule that an adapter needing an operation "refuses the run instead of silently continuing
 * without durability".
 */
import {
  StoreWriteLog,
  storeDurability,
  type EngineSessionKey,
  type EngineSessionStore,
  type EngineTranscriptEntry,
  type SessionDurabilityVerdict,
} from '@agent-workspace/engine';

/** The entry type every stored item is wrapped in. */
export const OPENAI_AGENTS_SESSION_ENTRY_TYPE = 'openai-agents.item';

/** An SDK input item, as far as this module needs to know: an object. */
export type OpenAiAgentsSessionItem = Readonly<Record<string, unknown>>;

function wrap(item: OpenAiAgentsSessionItem): EngineTranscriptEntry {
  return { type: OPENAI_AGENTS_SESSION_ENTRY_TYPE, item };
}

function unwrap(entry: EngineTranscriptEntry): OpenAiAgentsSessionItem | null {
  if (entry.type !== OPENAI_AGENTS_SESSION_ENTRY_TYPE) return null;
  const item = entry['item'];
  return typeof item === 'object' && item !== null && !Array.isArray(item)
    ? (item as OpenAiAgentsSessionItem)
    : null;
}

/**
 * A `Session` over one store stream, with the durability evidence the port asks for.
 *
 * Every write is counted when it resolves and recorded when it rejects; the rejection is
 * re-thrown, because the SDK's own policy decides whether a failed write ends the run.
 */
export class EngineStoreSession {
  readonly #store: EngineSessionStore;
  readonly #key: EngineSessionKey;
  readonly #log = new StoreWriteLog();

  constructor(store: EngineSessionStore, key: EngineSessionKey) {
    this.#store = store;
    this.#key = key;
  }

  getSessionId(): Promise<string> {
    return Promise.resolve(this.#key.sessionId);
  }

  async getItems(limit?: number): Promise<OpenAiAgentsSessionItem[]> {
    const loaded = await this.#store.load(this.#key);
    if (loaded === null) return [];
    const items: OpenAiAgentsSessionItem[] = [];
    for (const entry of loaded) {
      const item = unwrap(entry);
      if (item === null) {
        throw new Error(
          `the session store holds an entry of type ${JSON.stringify(entry.type)} in an openai-agents stream; refusing to resume from state this adapter did not write.`,
        );
      }
      items.push(item);
    }
    return limit === undefined ? items : items.slice(Math.max(0, items.length - limit));
  }

  async addItems(items: readonly OpenAiAgentsSessionItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.#log.track(() => this.#store.append(this.#key, items.map(wrap)));
  }

  async popItem(): Promise<OpenAiAgentsSessionItem | undefined> {
    const deleteLast = this.#store.deleteLast?.bind(this.#store);
    if (deleteLast === undefined) {
      throw new Error(
        'the session store offers no deleteLast, so popItem cannot be honoured durably; refusing rather than popping only in memory.',
      );
    }
    const items = await this.getItems();
    const last = items.at(-1);
    if (last === undefined) return undefined;
    await this.#log.track(() => deleteLast(this.#key));
    return last;
  }

  async clearSession(): Promise<void> {
    const replaceAll = this.#store.replaceAll?.bind(this.#store);
    if (replaceAll === undefined) {
      throw new Error(
        'the session store offers no replaceAll, so clearSession cannot be honoured durably; refusing rather than clearing only in memory.',
      );
    }
    await this.#log.track(() => replaceAll(this.#key, []));
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
export function openAiAgentsDurability(state: {
  readonly session: EngineStoreSession | null;
  readonly completed: boolean;
}): SessionDurabilityVerdict {
  return storeDurability(state.session, state.completed);
}
