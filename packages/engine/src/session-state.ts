/**
 * `@agent-workspace/engine/session-state` — what every engine's session store shares (ENG-06, #305).
 *
 * Four things, and each is here rather than in an adapter or in the runner because it is a
 * statement about *the store*, not about an engine:
 *
 *   1. {@link SESSION_STATE_BLOB_MAX_BYTES} — the cap a blob snapshot is refused over.
 *   2. {@link engineStreamKey} — how a {@link EngineSessionKey} becomes the one opaque string the
 *      platform stores state under. The Claude adapter's key is two fields; every other engine's is
 *      one; the store's is always one.
 *   3. {@link withStoreWriteFailures} — the durability verdict, with the store's own failures folded
 *      in. Before ENG-06 the only evidence a batch had been lost was the Agent SDK's
 *      `system/mirror_error` event, so the verdict could only be honest for Claude.
 *   4. {@link StoreWriteLog} and {@link storeDurability} — the write count an adapter's session
 *      bridge keeps and the durability verdict read from it (#951).
 *
 * Pure functions and constants. The module imports nothing but the port's own types, for the reason
 * `port.ts`'s header gives about the port importing nothing but contracts.
 */
import type { EngineSessionKey, SessionDurabilityVerdict } from './port.js';

/**
 * The largest session-state blob the platform stores, in bytes.
 *
 * 32 MiB. The number is a judgement and the shape of the judgement is what matters: a blob is an
 * agent's own state directory snapshotted, so the cap has to be well above a conversation's worth of
 * JSON and well below anything a control-plane request should hold in memory. `apps/web`'s file
 * upload cap is 64 MiB (`apps/web/server/files/http.ts`) and that is a *tenant's* file, deliberately
 * larger than an engine's internal bookkeeping.
 *
 * It is a refusal, never a truncation: a snapshot cut off at the cap is a state directory that
 * replays into an agent as something its own code never wrote.
 */
export const SESSION_STATE_BLOB_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Render one {@link EngineSessionKey} as the store's opaque `streamKey`.
 *
 * `projectKey + '/' + subpath`, with the empty string for an absent `subpath`. Two properties make
 * this the right join and both are worth stating, because a separator is a claim about two
 * grammars:
 *
 *   * it is **injective** over the keys the platform can produce. `projectKey` is
 *     `/^[A-Za-z0-9_-]{1,64}$/` (the Agent SDK's own validator, restated by
 *     `apps/web/server/sessions/transcript.ts`) and so cannot contain `/`, which means the first `/`
 *     always ends the project key and the rest is exactly the subpath;
 *   * it is **total**: the main transcript's key ends in a bare `/`, which is a different string from
 *     any subagent's, so the two do not collapse onto one stream.
 */
export function engineStreamKey(key: EngineSessionKey): string {
  return `${key.projectKey}/${key.subpath ?? ''}`;
}

/**
 * Fold a store's recorded write failures into an adapter's durability verdict.
 *
 * ADR-0015's shape applied to two independent observers: the adapter says what *it* saw (for Claude,
 * `append()` rejections and `system/mirror_error` events), the store says what *it* could not write,
 * and a run is durable only when neither has anything to report. A failure recorded by the store
 * therefore makes the verdict `false` **whatever the adapter said**, which is the property that makes
 * this engine-neutral: an adapter with no `mirror_error` concept still cannot report a durable run
 * over a store that dropped a write.
 *
 * The `false` arm keeps the adapter's own reason when it had one, because two sentences about the
 * same run are more useful to an operator than the later one alone.
 */
export function withStoreWriteFailures(
  verdict: SessionDurabilityVerdict,
  failures: readonly string[],
): SessionDurabilityVerdict {
  if (failures.length === 0) return verdict;
  const first = failures[0] ?? '(none recorded)';
  const store =
    `${String(failures.length)} session-store write(s) failed, so this run's state is not ` +
    `completely durable (spec §14.9). First: ${first}`;
  return verdict.durable
    ? { durable: false, reason: store }
    : { durable: false, reason: `${verdict.reason} Additionally, ${store}` };
}

/** What a durability verdict reads from a session bridge. */
export type StoreWriteRecord = { writes(): number; failures(): readonly string[] };

/** Counts the writes a store accepted; records and re-throws the ones it refused. */
export class StoreWriteLog implements StoreWriteRecord {
  #writes = 0;
  readonly #failures: string[] = [];

  async track(write: () => Promise<void>): Promise<void> {
    try {
      await write();
      this.#writes += 1;
    } catch (error) {
      this.#failures.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Writes the store accepted. */
  writes(): number {
    return this.#writes;
  }

  /** Writes the store refused, in order. */
  failures(): readonly string[] {
    return [...this.#failures];
  }
}

/**
 * The port's durability verdict for one run (spec §14.9). `true` only when a store was supplied,
 * the stream reached its terminal event, at least one write resolved and none failed.
 */
export function storeDurability(
  record: StoreWriteRecord | null,
  completed: boolean,
): SessionDurabilityVerdict {
  if (record === null) {
    return {
      durable: false,
      reason:
        'no session store was supplied, so this session exists only inside the sandbox (spec §14.9).',
    };
  }
  if (!completed) {
    return { durable: false, reason: 'the run stream has not reached its terminal event.' };
  }
  const failures = record.failures();
  if (failures.length > 0) {
    return {
      durable: false,
      reason: `${String(failures.length)} session write(s) failed; first: ${failures[0] ?? ''}`,
    };
  }
  if (record.writes() === 0) {
    return { durable: false, reason: 'the session store accepted no write for this run.' };
  }
  return { durable: true, mirroredBatches: record.writes() };
}
