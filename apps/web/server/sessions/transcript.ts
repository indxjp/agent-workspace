/**
 * The durable `SessionStore` of spec §20, as the control plane owns it.
 *
 * ## What this file is for
 *
 * Spec §14.9 states the release blocker in one sentence: *"For the session to actually resume,
 * the durable `SessionStore` (section 20) must persist the Agent SDK session state, not only the
 * session id. If session state lives solely in `CLAUDE_CONFIG_DIR` inside a sandbox, a runtime
 * switch silently loses the conversation."* R-01 §6 verified that fear live — with no further
 * configuration a session is one JSONL file at
 * `<CLAUDE_CONFIG_DIR>/projects/<projectKey>/<sessionId>.jsonl` on the machine that ran the
 * query, and destroying the sandbox destroys the conversation.
 *
 * The SDK's remedy is `Options.sessionStore`, an adapter it dual-writes every transcript batch
 * to. {@link TranscriptStore} is that adapter's contract, restated in platform-owned types so
 * that nothing here imports `@anthropic-ai/claude-agent-sdk` (spec §42 — the only file that may
 * is `packages/engine-claude-agent-sdk/src/boundary.ts`, which restates the same shape as its `TranscriptMirror`).
 *
 * ## Why the types are copied rather than imported, twice over
 *
 * `packages/engine-claude-agent-sdk/src/boundary.ts` already restates the SDK's `SessionStore` and makes the compiler
 * check both directions of assignability at its one call site. This module cannot import that
 * restatement either: `apps/web` does not depend on `@agent-workspace/runner`, and
 * `apps/web/package.json` is not this task's file to edit (ADR-0017 — a manifest belongs to its
 * package). The two declarations are therefore structurally identical and nominally unrelated,
 * exactly as `apps/runner/src/runtime.ts` and `packages/runtime/src/driver.ts` already are, and
 * the duplication is declared on this task's PR rather than hidden.
 *
 * What keeps them from drifting is not this comment, and until this branch's second round it was
 * not what this comment said either. It claimed `apps/runner/src/session.ts` built its
 * `TranscriptMirror` out of the wire format this file defines, *"so a divergence stops that file
 * compiling"*. **There is no such edge.** `session.ts` imports one thing, `./claude.js`, and
 * `apps/runner/package.json` names `@agent-workspace/core` and the Agent SDK and nothing from
 * `apps/web`. A verifier renamed one response field on this side, updated this side's own test in
 * lockstep as a maintainer would, and `pnpm typecheck`, `pnpm lint` and 1 059 tests stayed green
 * while resume broke against a real model.
 *
 * What watches it now is `wire-contract.test.ts`, beside this file: it reads
 * `apps/runner/src/session.ts` with the TypeScript AST, takes the paths, query names, request
 * fields and response fields the mirror actually speaks, and **replays them against these
 * handlers**. A rename on either side turns it red, and its header states in full what it does
 * and does not reach. The bound worth knowing here: it compares the **wire**, and the two type
 * declarations are still two hand-written types with no compiler edge between them, so a member
 * added to one and not the other is caught only if the wire exercises it. That is on this task's
 * PR as a declared gap, with the shape of the fix — one shared package — named there.
 *
 * ## Everything here parses before it compares
 *
 * A transcript entry arrives over HTTP from a sandbox. A `projectKey` arrives from the SDK, which
 * R-01 §7 records will *silently* substitute the sanitised `cwd` when its own validator refuses
 * the value the runner asked for — the exact cross-tenant collision spec §25 forbids. So every
 * key, entry and batch is parsed by a function that ends in an `else` which rejects by name
 * (ADR-0015), and none of them ever throws: a malformed body is a 400 with a sentence, never an
 * exception that becomes a 500.
 */

// ── The stored shape ─────────────────────────────────────────────────────────────────────

/**
 * The key the SDK hands its store for one transcript. The SDK's `SessionKey`, restated.
 *
 * `projectKey` is spec §25's tenant key. R-01 §7: it is an **input** the SDK supplies to the
 * adapter, there is no `projectKey` option, and the only lever that sets it is
 * `CLAUDE_CODE_PROJECT_DIR_NAME` beside `CLAUDE_CONFIG_DIR` in the run's `env`.
 *
 * `subpath` is absent for the main transcript and set for a subagent's (`subagents/agent-<id>`).
 * R-01 §7 is explicit that the empty string is invalid and that the field is opaque to the
 * adapter — it is a storage-key suffix and nothing else.
 */
export interface TranscriptKey {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly subpath?: string;
}

/** One JSONL transcript line. The SDK's `SessionStoreEntry`, restated. */
export interface TranscriptEntry {
  readonly type: string;
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly [field: string]: unknown;
}

/** One row of `listSessions`. `mtime` is integer epoch milliseconds — the storage write time. */
export interface TranscriptSessionListing {
  readonly sessionId: string;
  readonly mtime: number;
}

/**
 * The durable store spec §20 requires, minus the one method that cannot be written outside the
 * SDK boundary.
 *
 * The SDK's `SessionStore` has two required members, `append` and `load`, and four optional ones.
 * Four of the six are here. `listSessionSummaries` is **deliberately absent**: R-01 §7 requires it
 * to be maintained inside `append()` with the SDK's exported `foldSessionSummary`, and importing
 * that function anywhere but `packages/engine-claude-agent-sdk/src/boundary.ts` violates spec §42. It is a declared gap
 * on this task's PR with the one-line change to the boundary that would close it.
 *
 * Every method is required here even though four are optional in the SDK. An optional method on a
 * platform port is a capability nobody can rely on; the adapter in `apps/runner/src/session.ts`
 * decides which of them it exposes to the SDK, and that decision belongs at the boundary.
 */
export interface TranscriptStore {
  /**
   * Persist a batch, upserting on `entry.uuid`.
   *
   * R-01 §7: the SDK retries a failed batch up to three times and *"retries can redeliver, so
   * `append()` must upsert on `entry.uuid`"*. Entries without a `uuid` — titles, tags, mode
   * markers — are appended without dedup, because they carry no identity to dedup on.
   *
   * Concurrent appends for one key must be serialised; the SDK's ordering rule is *"within a
   * single process, persist entries in append-call order"*.
   */
  append(key: TranscriptKey, entries: readonly TranscriptEntry[]): Promise<void>;
  /**
   * Everything appended under this key, in order, or `null` when the key is unknown.
   *
   * `null` and `[]` are different answers and the difference is load-bearing: `[]` says the
   * session exists and is empty, `null` says it was never written, and the SDK resumes only the
   * first.
   */
  load(key: TranscriptKey): Promise<TranscriptEntry[] | null>;
  /** Main transcripts under one tenant key, for §20's *List sessions* and the SDK's `continue`. */
  listSessions(projectKey: string): Promise<TranscriptSessionListing[]>;
  /**
   * Remove one transcript. On a main key this cascades to every subkey, because R-01 §7 requires
   * `delete(mainKey)` to.
   */
  delete(key: TranscriptKey): Promise<void>;
  /** The `subpath`s stored under one session. Without it, resume loses subagent transcripts. */
  listSubkeys(key: { readonly projectKey: string; readonly sessionId: string }): Promise<string[]>;
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────

/** A parse that either produced a value or says, in one sentence, why it did not. */
export type Parsed<T> = { readonly ok: true; readonly value: T } | ParseRejection;

interface ParseRejection {
  readonly ok: false;
  readonly reason: string;
}

/** Name a value in a rejection without stringifying something huge or cyclic. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  return `a value of type ${typeof value}`;
}

/**
 * The SDK's own validator for `CLAUDE_CODE_PROJECT_DIR_NAME`, which becomes `projectKey`.
 *
 * Read out of the shipped `sdk.mjs` by R-01 §7 and quoted there: the resolver is gated on
 * `/^[A-Za-z0-9_-]{1,64}$/`. `packages/run-protocol/src/schemas.ts` applies the same pair to the run
 * request; this copy exists because the control plane must reject a key the *SDK* accepted but
 * the platform did not issue, and it is reached from a Next.js route that does not depend on the
 * runner.
 */
export const PROJECT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Reserved Windows device names. R-01 §7 rule 2: the SDK ignores one of these, silently. */
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** RFC 4122 text form, which is what `Options.sessionId` and `resume` both require (R-01 §6). */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `subpath` this store will accept as a key suffix.
 *
 * The SDK writes `subagents/agent-<id>`. Everything about the grammar below is a refusal of
 * something a filesystem-backed adapter would otherwise interpret: no leading `/`, no `..`
 * segment, no backslash, no character outside the set, and a bounded length. The field is opaque
 * to an adapter, so the adapter's job is to store it, not to understand it — but a value that can
 * escape the directory it is stored under is not opaque, it is a path traversal.
 */
export const SUBPATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/** The longest `subpath` accepted, so a key cannot be used to write an unbounded filename. */
export const MAX_SUBPATH_LENGTH = 128;

/**
 * Parse a `projectKey`. Total, and every rejection names what it saw.
 *
 * This is the §25 check, and it is the one R-01 §7 says the platform must make for itself: an
 * invalid `CLAUDE_CODE_PROJECT_DIR_NAME` does not throw inside the SDK, it falls back to the
 * sanitised `cwd`, and two tenants whose sandboxes share a workspace path then share a key
 * namespace. A store that accepted whatever arrived would persist that collision.
 */
export function parseProjectKey(input: unknown): Parsed<string> {
  if (typeof input !== 'string') {
    return { ok: false, reason: `projectKey must be a string; got ${describe(input)}.` };
  }
  if (!PROJECT_KEY_PATTERN.test(input)) {
    return {
      ok: false,
      reason:
        `projectKey ${JSON.stringify(input)} fails the SDK's own validator ` +
        `/^[A-Za-z0-9_-]{1,64}$/ (R-01 §7 rule 2). The SDK would ignore a value like this ` +
        `silently and key the session under the sanitised cwd, which is a cross-tenant collision.`,
    };
  }
  if (WINDOWS_DEVICE_NAME_PATTERN.test(input)) {
    return {
      ok: false,
      reason:
        `projectKey ${JSON.stringify(input)} is a reserved Windows device name, which the SDK ` +
        `also ignores silently (R-01 §7 rule 2).`,
    };
  }
  return { ok: true, value: input };
}

/** Parse a Claude session id. The SDK requires a UUID for `sessionId` and for `resume`. */
export function parseSessionId(input: unknown): Parsed<string> {
  if (typeof input !== 'string') {
    return { ok: false, reason: `sessionId must be a string; got ${describe(input)}.` };
  }
  if (!SESSION_ID_PATTERN.test(input)) {
    return {
      ok: false,
      reason: `sessionId ${JSON.stringify(input)} is not a UUID, which is what the SDK's \`resume\` requires (R-01 §6).`,
    };
  }
  return { ok: true, value: input };
}

/**
 * Parse an optional `subpath`. `undefined` and `null` both mean *the main transcript*.
 *
 * The empty string is **not** one of those: R-01 §7 records it as invalid, and treating it as
 * "absent" would make two different keys collapse onto one stored transcript.
 */
export function parseSubpath(input: unknown): Parsed<string | undefined> {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== 'string') {
    return { ok: false, reason: `subpath must be a string when present; got ${describe(input)}.` };
  }
  if (input.length === 0) {
    return {
      ok: false,
      reason:
        'subpath is the empty string. R-01 §7: an empty subpath is invalid — omit the field for ' +
        'the main transcript rather than sending "".',
    };
  }
  if (input.length > MAX_SUBPATH_LENGTH) {
    return {
      ok: false,
      reason: `subpath is ${String(input.length)} characters; the limit is ${String(MAX_SUBPATH_LENGTH)}.`,
    };
  }
  if (!SUBPATH_PATTERN.test(input)) {
    return {
      ok: false,
      reason:
        `subpath ${JSON.stringify(input)} is not accepted. It must be one or more ` +
        `\`[A-Za-z0-9][A-Za-z0-9_-]*\` segments joined by \`/\` — the shape the SDK writes ` +
        `("subagents/agent-<id>"). Anything else, including a \`..\` segment, an absolute path, ` +
        `a backslash or a percent-encoded separator, is refused rather than interpreted.`,
    };
  }
  return { ok: true, value: input };
}

/** Parse a whole key. Named fields so a rejection says which one was wrong. */
export function parseTranscriptKey(input: unknown): Parsed<TranscriptKey> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: `a transcript key must be an object; got ${describe(input)}.` };
  }
  const record = input as Record<string, unknown>;
  const projectKey = parseProjectKey(record['projectKey']);
  if (!projectKey.ok) return projectKey;
  const sessionId = parseSessionId(record['sessionId']);
  if (!sessionId.ok) return sessionId;
  const subpath = parseSubpath(record['subpath']);
  if (!subpath.ok) return subpath;
  return {
    ok: true,
    value:
      subpath.value === undefined
        ? { projectKey: projectKey.value, sessionId: sessionId.value }
        : { projectKey: projectKey.value, sessionId: sessionId.value, subpath: subpath.value },
  };
}

/** The largest single batch this store accepts, in entries. */
const MAX_BATCH_ENTRIES = 5_000;

/** A UTF-16 surrogate with no partner; with the `u` flag a well-formed pair is one code point. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Nesting beyond this is refused, so the walk below cannot overflow the stack on hostile input. */
const MAX_ENTRY_DEPTH = 128;

/** A NUL or a lone surrogate: text PostgreSQL's `jsonb` refuses to store. */
function unstorable(text: string): boolean {
  return text.includes('\u0000') || LONE_SURROGATE.test(text);
}

/**
 * Where in `value` a string (or an object key) PostgreSQL cannot store sits, as a path such as
 * `message.content[0].text`, or `null` when there is none.
 *
 * Both stores refuse such an entry, so the durable one cannot answer an append the in-memory one
 * accepted with a raw database error (W3-4, `store.test.ts`).
 */
export function unstorableTextPath(value: unknown, path = 'entry', depth = 0): string | null {
  if (depth > MAX_ENTRY_DEPTH)
    return `${path} (nested deeper than ${String(MAX_ENTRY_DEPTH)} levels)`;
  if (typeof value === 'string') return unstorable(value) ? path : null;
  if (typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = unstorableTextPath(item, `${path}[${String(index)}]`, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (unstorable(key)) return `${path} (a key)`;
    const found = unstorableTextPath(item, `${path}.${key}`, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Parse one transcript entry.
 *
 * The SDK's `SessionStoreEntry` requires a string `type` and permits any other field, so the
 * check is exactly that and no more: an entry is stored **verbatim**, because the SDK owns its
 * content and R-01 §7 requires `load()` to return entries deep-equal to what was appended. A
 * validator that dropped an unrecognised field would silently corrupt a resume.
 */
export function parseTranscriptEntry(input: unknown): Parsed<TranscriptEntry> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: `a transcript entry must be an object; got ${describe(input)}.` };
  }
  const record = input as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string') {
    return {
      ok: false,
      reason: `a transcript entry must carry a string 'type'; got ${describe(type)}.`,
    };
  }
  const uuid = record['uuid'];
  if (uuid !== undefined && typeof uuid !== 'string') {
    return { ok: false, reason: `'uuid' must be a string when present; got ${describe(uuid)}.` };
  }
  const timestamp = record['timestamp'];
  if (timestamp !== undefined && typeof timestamp !== 'string') {
    return {
      ok: false,
      reason: `'timestamp' must be a string when present; got ${describe(timestamp)}.`,
    };
  }
  const unstorable = unstorableTextPath(record);
  if (unstorable !== null) {
    return {
      ok: false,
      reason: `${unstorable} cannot be stored: it carries a NUL character or an unpaired surrogate, or nests too deeply.`,
    };
  }
  return { ok: true, value: record as TranscriptEntry };
}

/** Parse a whole batch. An empty batch is legal — the SDK flushes one on some runs. */
export function parseTranscriptEntries(input: unknown): Parsed<TranscriptEntry[]> {
  if (!Array.isArray(input)) {
    return { ok: false, reason: `entries must be an array; got ${describe(input)}.` };
  }
  if (input.length > MAX_BATCH_ENTRIES) {
    return {
      ok: false,
      reason: `a batch of ${String(input.length)} entries exceeds the limit of ${String(MAX_BATCH_ENTRIES)}.`,
    };
  }
  const entries: TranscriptEntry[] = [];
  for (const [index, raw] of input.entries()) {
    const entry = parseTranscriptEntry(raw);
    if (!entry.ok) return { ok: false, reason: `entries[${String(index)}]: ${entry.reason}` };
    entries.push(entry.value);
  }
  return { ok: true, value: entries };
}

// ── The rule both backends share ─────────────────────────────────────────────────────────

/**
 * Merge a batch into what is already stored, upserting on `uuid`.
 *
 * R-01 §7, verbatim on both halves: *"Retries can redeliver, so `append()` must **upsert on
 * `entry.uuid`**. Entries without a `uuid` (titles, tags, mode markers) are appended without
 * dedup."* An upsert replaces **in place** rather than moving the entry to the end, because the
 * transcript is a chain and a redelivery must not reorder it.
 *
 * This function is shared by every backend on purpose. It is the only piece of `append()` that is
 * a *rule* rather than a storage mechanism, and a rule implemented twice is two rules.
 */
export function mergeTranscriptEntries(
  existing: readonly TranscriptEntry[],
  incoming: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const merged = [...existing];
  const positionOf = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (typeof entry.uuid === 'string') positionOf.set(entry.uuid, index);
  }
  for (const entry of incoming) {
    const uuid = entry.uuid;
    if (typeof uuid !== 'string') {
      merged.push(entry);
      continue;
    }
    const at = positionOf.get(uuid);
    if (at === undefined) {
      positionOf.set(uuid, merged.length);
      merged.push(entry);
      continue;
    }
    merged[at] = entry;
  }
  return merged;
}

/**
 * Serialise work per key, so two concurrent `append()` calls cannot read-modify-write over each
 * other.
 *
 * Both backends are read-modify-write — the upsert rule above needs the current contents — so
 * neither is safe under concurrency without this. It is a per-key promise chain rather than a
 * lock because a promise chain cannot be forgotten to be released.
 *
 * The scope it buys is **one process**, which is honest about what it is: two control-plane
 * replicas appending to one session concurrently are ordered by the storage layer, which is why
 * the SDK's own rule reads *"across concurrent processes, order is by storage commit time"*.
 */
export class KeyedSerialiser {
  readonly #chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The chain must not reject, or every later call on this key inherits the rejection. The
    // caller still sees the real outcome through `next`.
    this.#chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

/**
 * A stable string for one key, used as the serialiser's chain id and as a map key.
 *
 * `JSON.stringify` of the three fields rather than a joined string with a separator character:
 * a separator has to be a character no field can contain, and picking one is a claim about three
 * grammars that a later change to any of them can invalidate silently. An array encoding cannot
 * be made ambiguous by a field's contents, and it is never parsed back — every reader that needs
 * the parts keeps the key itself.
 */
export function transcriptKeyId(key: TranscriptKey): string {
  return JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null]);
}
