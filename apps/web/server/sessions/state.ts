/**
 * The engine-scoped session store, as the control plane owns it (ENG-06, #305).
 *
 * ## What this file is for
 *
 * `./transcript.ts` is the same idea, Claude-shaped: its key is the Agent SDK's `SessionKey`
 * (`projectKey`, `sessionId`, `subpath`) and its entries are the SDK's `SessionStoreEntry`. Every
 * other engine keys a conversation differently — pi by one JSONL file per session, the OpenAI Agents
 * SDK by a flat item list, an ACP agent by the files in its own state directory — so a store keyed by
 * two fields of one SDK's key has nowhere to put theirs.
 *
 * {@link SessionStateStore} is the generalisation: state lives in **streams** keyed by
 * `(session, engine, streamKey)`, where `streamKey` is one opaque adapter-defined string, plus
 * **blobs** for an engine whose state is bytes rather than a list. The platform reads no field of an
 * entry and no byte of a blob.
 *
 * ## Everything here parses before it compares
 *
 * Every value arrives over HTTP from a sandbox: the engine id, the stream key, the blob key, the
 * cursor and the entries. So each has a total parser that ends in a rejection naming what it saw
 * (ADR-0015), and none of them throws — a malformed request is a 400 with a sentence, never an
 * exception that becomes a 500.
 *
 * The two keys are opaque to the platform and are still **bounded and character-checked**, for two
 * different reasons. `streamKey` goes into a URL query and a database index, so it is printable ASCII
 * of bounded length. `blobKey` additionally becomes part of an object-store key, so it is checked
 * against the same segment grammar `./transcript.ts` applies to `subpath`: a value that can escape
 * the prefix it is stored under is not opaque, it is a path traversal.
 */
import { ENGINE_IDS, type EngineId } from '@indx-workspace/contracts/engines';

import type { Parsed } from './transcript';

// ── The stored shape ─────────────────────────────────────────────────────────────────────

/**
 * Which stream.
 *
 * `workspaceId` is the tenant, taken from the **authenticated principal** and never from the
 * request — the same arrangement `./transcript.ts`'s `projectKey` already has, and for the same
 * reason: a store whose methods took no tenant would need a caller to remember to filter, and a
 * store bound to one tenant at construction cannot serve a process that handles every tenant.
 * `sessionId` is the platform's `sessions.id`, never the engine's own id.
 */
export interface SessionStateStreamRef {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly engine: EngineId;
  readonly streamKey: string;
}

/** Which blob. The same tenant and session fields, with the adapter's opaque blob key. */
export interface SessionStateBlobRef {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly engine: EngineId;
  readonly blobKey: string;
}

/** One entry as a writer sends it: the opaque payload, and the idempotency key if it has one. */
export interface SessionStateEntryPayload {
  readonly entryKey?: string | undefined;
  readonly entry: Readonly<Record<string, unknown>>;
}

/** One entry as a reader gets it back, with the sequence a cursor pages by. */
export interface SessionStateEntryRecord {
  readonly sequence: number;
  readonly entryKey: string | null;
  readonly entry: Readonly<Record<string, unknown>>;
}

/** One stream of one session, as the stream listing reports it. */
export interface SessionStateStreamRecord {
  readonly engine: EngineId;
  readonly streamKey: string;
  /** Integer epoch milliseconds of the last write — the Agent SDK's `mtime`. */
  readonly updatedAt: number;
}

/** What a blob read answers. `sha256` is what was recorded when the bytes were written. */
export interface SessionStateBlobContent {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/**
 * What a blob operation answers when this deployment has nowhere to put bytes.
 *
 * A typed arm rather than a throw, and rather than an optional method. A deployment with no object
 * storage configured can still store every *entry* — those are database rows — so the store is
 * installed and only its blob half is absent, and the route turns this into a 503 naming the
 * variable instead of a 500 naming an exception. ADR-0035: an absent capability is reported, never
 * substituted.
 */
export interface SessionStateBlobsUnavailable {
  readonly ok: false;
  readonly reason: string;
}

/**
 * The store the routes are written against.
 *
 * Every method is required, unlike `@agent-workspace/engine`'s `EngineSessionStore`, whose optional
 * members describe what one *engine's* store offers. This is the platform's own store, and a route
 * that could not answer because the installed store happens not to implement a method would be a
 * capability nobody can rely on (the same reasoning `./transcript.ts`'s `TranscriptStore` records).
 */
export interface SessionStateStore {
  /** Persist a batch, upserting on `entryKey` in place and appending keyless entries. */
  append(ref: SessionStateStreamRef, entries: readonly SessionStateEntryPayload[]): Promise<void>;
  /**
   * The stream's entries after `afterSequence`, in order, or `null` when the stream is unknown.
   *
   * `null` and `[]` are different answers and the difference is load-bearing: `[]` says the stream
   * exists and is empty, `null` says it was never written, and only the first resumes.
   */
  list(
    ref: SessionStateStreamRef,
    page: { readonly afterSequence?: number | undefined; readonly limit?: number | undefined },
  ): Promise<readonly SessionStateEntryRecord[] | null>;
  /** Remove the highest-sequence entry; answers how many rows went (0 for an empty stream). */
  deleteLast(ref: SessionStateStreamRef): Promise<number>;
  /** Replace every entry with exactly these, renumbered from 1. */
  replaceAll(
    ref: SessionStateStreamRef,
    entries: readonly SessionStateEntryPayload[],
  ): Promise<void>;
  /** Remove one stream and its entries. Idempotent. */
  deleteStream(ref: SessionStateStreamRef): Promise<void>;
  /** Every stream of one session, newest write first. */
  listStreams(tenant: {
    readonly workspaceId: string;
    readonly sessionId: string;
  }): Promise<readonly SessionStateStreamRecord[]>;
  /** Store a snapshot, replacing whatever was under this key. */
  putBlob(
    ref: SessionStateBlobRef,
    bytes: Uint8Array,
  ): Promise<{ readonly ok: true } | SessionStateBlobsUnavailable>;
  /** The snapshot under this key, `null` when there is none, or the unavailable arm. */
  getBlob(
    ref: SessionStateBlobRef,
  ): Promise<
    | { readonly ok: true; readonly content: SessionStateBlobContent | null }
    | SessionStateBlobsUnavailable
  >;
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────

/** Name a value in a rejection without stringifying something huge or cyclic. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  return `a value of type ${typeof value}`;
}

/** The longest `streamKey` or `blobKey` this store accepts. */
export const MAX_SESSION_STATE_KEY_LENGTH = 512;

/**
 * A `streamKey` this store will accept.
 *
 * Printable ASCII, bounded. Deliberately permissive about *structure* — the field is adapter-defined
 * and the platform promises not to interpret it — and deliberately strict about *bytes*: the value
 * travels in a URL query and goes into a btree index, and neither a control character nor a
 * multi-byte sequence the two sides normalise differently is something a key may contain.
 */
export const STREAM_KEY_PATTERN = /^[\x20-\x7E]+$/;

/**
 * A `blobKey` this store will accept.
 *
 * One or more `[A-Za-z0-9][A-Za-z0-9._-]*` segments joined by `/`, which is the same grammar
 * `./transcript.ts` applies to `subpath` widened by `.` for a file extension. A segment must start
 * with a letter or a digit, so `..` is not a segment this grammar has — the traversal is refused by
 * the positive rule rather than by a second rule about `..` that has to be kept in step with it.
 */
export const BLOB_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** The largest batch of entries this store accepts in one request. */
export const MAX_SESSION_STATE_BATCH_ENTRIES = 5_000;

/** Parse an engine id against `@indx-workspace/contracts`' closed set. */
export function parseEngineId(input: unknown): Parsed<EngineId> {
  if (typeof input !== 'string') {
    return { ok: false, reason: `engine must be a string; got ${describe(input)}.` };
  }
  const found = ENGINE_IDS.find((id) => id === input);
  if (found === undefined) {
    return {
      ok: false,
      reason:
        `engine ${JSON.stringify(input)} is not one of ${ENGINE_IDS.join(', ')}. A stream is ` +
        `engine-scoped, so a state write has to name an engine this platform knows.`,
    };
  }
  return { ok: true, value: found };
}

export function parseStreamKey(input: unknown): Parsed<string> {
  if (typeof input !== 'string') {
    return { ok: false, reason: `streamKey must be a string; got ${describe(input)}.` };
  }
  if (input.length === 0) {
    return {
      ok: false,
      reason:
        'streamKey is the empty string. Every engine has at least one stream and it has a name; ' +
        'the Claude adapter\'s main transcript is "<projectKey>/".',
    };
  }
  if (input.length > MAX_SESSION_STATE_KEY_LENGTH) {
    return {
      ok: false,
      reason: `streamKey is ${String(input.length)} characters; the limit is ${String(MAX_SESSION_STATE_KEY_LENGTH)}.`,
    };
  }
  if (!STREAM_KEY_PATTERN.test(input)) {
    return {
      ok: false,
      reason:
        `streamKey ${JSON.stringify(input)} is not accepted: it must be printable ASCII. The key ` +
        `is opaque to the platform, which is why its grammar is about bytes rather than structure.`,
    };
  }
  return { ok: true, value: input };
}

export function parseBlobKey(input: unknown): Parsed<string> {
  if (typeof input !== 'string') {
    return { ok: false, reason: `blobKey must be a string; got ${describe(input)}.` };
  }
  if (input.length === 0 || input.length > MAX_SESSION_STATE_KEY_LENGTH) {
    return {
      ok: false,
      reason: `blobKey must be 1 to ${String(MAX_SESSION_STATE_KEY_LENGTH)} characters; got ${String(input.length)}.`,
    };
  }
  if (!BLOB_KEY_PATTERN.test(input)) {
    return {
      ok: false,
      reason:
        `blobKey ${JSON.stringify(input)} is not accepted. It must be one or more ` +
        `\`[A-Za-z0-9][A-Za-z0-9._-]*\` segments joined by \`/\`. A blob key becomes part of an ` +
        `object-store key, so an absolute path, a \`..\` segment, a backslash or a percent-encoded ` +
        `separator is refused rather than interpreted.`,
    };
  }
  return { ok: true, value: input };
}

/**
 * Parse a cursor. Absent means "from the beginning"; `0` is a legal cursor and means the same.
 *
 * Parsed then compared, never the other way round: `Number('7x')` is `NaN` and `NaN < 0` is false,
 * so a check written as "reject when negative" would read a malformed cursor as valid and page from
 * somewhere the caller did not ask for.
 */
export function parseSequenceCursor(input: unknown): Parsed<number | undefined> {
  if (input === undefined || input === null || input === '') return { ok: true, value: undefined };
  if (typeof input !== 'string' && typeof input !== 'number') {
    return { ok: false, reason: `after must be an integer when present; got ${describe(input)}.` };
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 0) {
    return {
      ok: false,
      reason: `after=${JSON.stringify(String(input))} is not a non-negative safe integer.`,
    };
  }
  return { ok: true, value };
}

/** Parse a page size. Absent means the store's own default. */
export function parsePageLimit(input: unknown): Parsed<number | undefined> {
  if (input === undefined || input === null || input === '') return { ok: true, value: undefined };
  if (typeof input !== 'string' && typeof input !== 'number') {
    return { ok: false, reason: `limit must be an integer when present; got ${describe(input)}.` };
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      ok: false,
      reason: `limit=${JSON.stringify(String(input))} is not a positive safe integer.`,
    };
  }
  return { ok: true, value };
}

/**
 * Parse one entry envelope.
 *
 * `entry` is stored **verbatim**: an engine owns its own state format, and a validator that dropped
 * an unrecognised field would silently corrupt a resume. So the check is exactly that it is a JSON
 * object, plus that `entryKey` — the one field the platform *does* read, because it is the
 * idempotency key — is a bounded string when present.
 */
export function parseSessionStateEntry(input: unknown): Parsed<SessionStateEntryPayload> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: `a state entry must be an object; got ${describe(input)}.` };
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'entryKey' && key !== 'entry') {
      return {
        ok: false,
        reason: `a state entry carries only 'entryKey' and 'entry'; got ${JSON.stringify(key)}.`,
      };
    }
  }
  const entry = record['entry'];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { ok: false, reason: `'entry' must be a JSON object; got ${describe(entry)}.` };
  }
  const entryKey = record['entryKey'];
  if (entryKey === undefined || entryKey === null) {
    return { ok: true, value: { entry: entry as Record<string, unknown> } };
  }
  if (typeof entryKey !== 'string') {
    return {
      ok: false,
      reason: `'entryKey' must be a string when present; got ${describe(entryKey)}.`,
    };
  }
  if (entryKey.length === 0 || entryKey.length > MAX_SESSION_STATE_KEY_LENGTH) {
    return {
      ok: false,
      reason:
        `'entryKey' must be 1 to ${String(MAX_SESSION_STATE_KEY_LENGTH)} characters; got ` +
        `${String(entryKey.length)}. Omit the field for an entry the engine gave no identity — ` +
        `the empty string would make two identity-less entries collide on one row.`,
    };
  }
  return { ok: true, value: { entryKey, entry: entry as Record<string, unknown> } };
}

/** Parse a whole batch. An empty batch is legal: it creates the stream and stores nothing. */
export function parseSessionStateEntries(input: unknown): Parsed<SessionStateEntryPayload[]> {
  if (!Array.isArray(input)) {
    return { ok: false, reason: `entries must be an array; got ${describe(input)}.` };
  }
  if (input.length > MAX_SESSION_STATE_BATCH_ENTRIES) {
    return {
      ok: false,
      reason: `a batch of ${String(input.length)} entries exceeds the limit of ${String(MAX_SESSION_STATE_BATCH_ENTRIES)}.`,
    };
  }
  const entries: SessionStateEntryPayload[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const entry = parseSessionStateEntry(raw);
    if (!entry.ok) return { ok: false, reason: `entries[${String(index)}]: ${entry.reason}` };
    const entryKey = entry.value.entryKey;
    if (entryKey !== undefined) {
      if (seen.has(entryKey)) {
        return {
          ok: false,
          reason:
            `entries[${String(index)}]: entryKey ${JSON.stringify(entryKey)} appears twice in one ` +
            `batch. One key names one entry, so a batch naming it twice is two different entries ` +
            `claiming one identity and the store cannot say which of them the stream should hold.`,
        };
      }
      seen.add(entryKey);
    }
    entries.push(entry.value);
  }
  return { ok: true, value: entries };
}

/**
 * The object-store key one blob's bytes are written at, relative to the workspace.
 *
 * Derived here and never taken from a request. `blobKey` has already been through
 * {@link parseBlobKey}, and `sessionId` is a UUID the route resolved against `sessions`, so every
 * segment of the result is a value the platform produced.
 */
export function sessionStateBlobStorageKey(ref: SessionStateBlobRef): string {
  return `session-state/${ref.sessionId}/${ref.engine}/${ref.blobKey}`;
}
