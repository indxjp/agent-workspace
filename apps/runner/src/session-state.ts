/**
 * `apps/runner/src/session-state.ts` — the sandbox's client of the engine-scoped session store
 * (ENG-06, #305; spec §20, §14.9).
 *
 * ## What it is
 *
 * `@agent-workspace/engine`'s {@link EngineSessionStore}, implemented over the control plane's
 * private `/api/sessions/:id/state-*` routes. The runner builds one per run and hands it to
 * whichever adapter the request named, as `EngineStartContext.sessionStore`; the Claude adapter
 * bridges it to the Agent SDK's own `SessionStore` and the SDK dual-writes every transcript batch
 * through it.
 *
 * ```text
 *   engine ──sessionStore──▶ this client ──HTTPS──▶ POST /api/sessions/<id>/state-entries
 *                                                   (apps/web/server/sessions/state-api.ts)
 * ```
 *
 * **Nothing here imports an engine SDK**, and nothing here opens a database connection: a sandbox
 * holding control-plane database credentials is what spec §24 and §25 are about, so the durable
 * store lives behind the control plane's HTTP surface and the sandbox is a client of it.
 *
 * ## What this replaced, and what it kept
 *
 * `./session.ts` used to hold an HTTP mirror of the **Agent SDK's** `SessionStore`, speaking
 * `/api/sessions/:id/transcript` and `/subkeys`. Those routes still exist — the public reads now
 * serve this store, with the Claude tables as their fallback (ADR-0071) — and the runner no longer
 * calls them:
 * one store, keyed by `(session, engine, streamKey)`, serves every engine. `./session.ts` keeps the
 * deployment configuration it always read, because where the control plane is remains a property of
 * the container and not of a run.
 *
 * ## The two things it does that a mirror did not
 *
 *   1. **It records its own failures.** {@link EngineSessionStore.writeFailures} is what lets the
 *      durability verdict be engine-neutral: before this, the only evidence a batch had been lost
 *      was the Agent SDK's own `system/mirror_error` event, so `sessionDurability()` could only be
 *      honest about Claude. `packages/engine`'s `withStoreWriteFailures` folds the two together.
 *   2. **It pages.** A resume reads a whole conversation back, and a conversation is not bounded by
 *      a request size, so `load()` follows the cursor until the control plane stops giving one.
 *      A page that came back short is still followed, because "short" is a fact about a limit the
 *      server chose and not about the end of a stream.
 */
import {
  engineStreamKey,
  SESSION_STATE_BLOB_MAX_BYTES,
  type EngineSessionKey,
  type EngineSessionStore,
  type EngineTranscriptEntry,
} from '@agent-workspace/engine';
import { ENGINE_CATALOGUE, isEngineId } from '@indx-workspace/contracts/engines';

/** What {@link createHttpEngineSessionStore} needs. `fetch` is a parameter so a test can supply one. */
export interface EngineSessionStoreDeps {
  /** The control plane's base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** The signed per-run token. Never a deployment-wide bearer. */
  readonly token: string;
  /** The engine this run is executing on. Every stream and blob is scoped to it. */
  readonly engine: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Everything after `<baseUrl>` for one session's entry streams. */
function entriesPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/state-entries`;
}

/** The stream listing — a sibling of `state-entries`, not a child (ADR-0026 decision 3). */
function streamsPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/state-streams`;
}

/** The blob snapshots of one session. */
function blobsPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/state-blobs`;
}

/**
 * The message a failed store call throws.
 *
 * It names the status and the body, because the caller is an engine's own retry loop and the only
 * place a person ever sees this text is the durability verdict of a run that ended without its
 * state being written.
 */
function failure(operation: string, url: string, status: number, body: string): Error {
  const detail = body.trim().length === 0 ? '(empty body)' : body.trim().slice(0, 500);
  return new Error(
    `session state ${operation} ${url} answered ${String(status)}: ${detail}. This batch of ` +
      `session state is NOT durable; spec §14.9 treats a session that survives only inside the ` +
      `sandbox as a release blocker.`,
  );
}

/** How long one store request may take. Small JSON round trips and one bounded blob. */
const DEFAULT_STATE_TIMEOUT_MS = 15_000;

/** The largest page `load()` asks for. Above the control plane's own ceiling is harmless. */
const PAGE_LIMIT = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** One page of entries, or `null` when the body was not one this client understands. */
function readEntryPage(
  body: unknown,
): { entries: EngineTranscriptEntry[]; nextCursor: number | null } | null {
  const record = asRecord(body);
  if (record === null) return null;
  const rows = record['entries'];
  if (!Array.isArray(rows)) return null;
  const entries: EngineTranscriptEntry[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (row === null) return null;
    // `sequence` and `entryKey` are read so that a rename of either on the control plane's side is
    // a failure here rather than a silently shorter transcript; `entry` is what the engine gets.
    if (typeof row['sequence'] !== 'number') return null;
    const entryKey = row['entryKey'];
    if (entryKey !== null && typeof entryKey !== 'string') return null;
    const entry = asRecord(row['entry']);
    if (entry === null || typeof entry['type'] !== 'string') return null;
    entries.push(entry as EngineTranscriptEntry);
  }
  const cursor = record['nextCursor'];
  if (cursor !== null && typeof cursor !== 'number') return null;
  return { entries, nextCursor: cursor };
}

/** The stream keys of one session, for this engine only. */
function readStreamKeys(body: unknown, engine: string): string[] | null {
  const record = asRecord(body);
  if (record === null) return null;
  const rows = record['streams'];
  if (!Array.isArray(rows)) return null;
  const keys: string[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (row === null) return null;
    const streamKey = row['streamKey'];
    if (typeof streamKey !== 'string' || typeof row['engine'] !== 'string') return null;
    if (typeof row['updatedAt'] !== 'number') return null;
    if (row['engine'] === engine) keys.push(streamKey);
  }
  return keys;
}

/**
 * Build the store the runner hands an adapter as `EngineStartContext.sessionStore`.
 *
 * Nothing here swallows a failure. An engine's own retry policy is what decides whether a rejected
 * write is retried, and a client that resolved on an HTTP 500 would convert a dropped batch into a
 * silent one and make the durability verdict a lie.
 */
export function createHttpEngineSessionStore(deps: EngineSessionStoreDeps): EngineSessionStore {
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_STATE_TIMEOUT_MS;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const engine = deps.engine;
  // An id the catalogue does not list gets append-only semantics.
  const entryKeyField = isEngineId(engine)
    ? (ENGINE_CATALOGUE[engine].sessionEntryKey ?? undefined)
    : undefined;
  const failures: string[] = [];

  const call = async (
    operation: string,
    path: string,
    init: { method: string; body?: string | Uint8Array; contentType?: string },
  ): Promise<Response> => {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${deps.token}`,
      accept: 'application/json',
    };
    if (init.contentType !== undefined) headers['content-type'] = init.contentType;
    try {
      return await doFetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `session state ${operation} ${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  /** Run one write, recording its failure before re-throwing it. See this file's header. */
  const write = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const streamQuery = (key: EngineSessionKey): string =>
    new URLSearchParams({ engine, streamKey: engineStreamKey(key) }).toString();

  /**
   * The wire body of an append or a replace.
   *
   * The entry array is built **before** `JSON.stringify` rather than inside it, and that is not a
   * style choice: `apps/web/server/sessions/wire-contract.test.ts` reads this file's syntax tree and
   * takes every property name under a `JSON.stringify` call as a *top-level* request field. A
   * literal built in place would make `entryKey` and `entry` look like fields of the request rather
   * than of an entry, and the gate would replay a body the control plane rightly refuses.
   */
  const entriesBody = (
    key: EngineSessionKey,
    entries: readonly EngineTranscriptEntry[],
  ): string => {
    const payload = entries.map((entry) => {
      const value = entryKeyField === undefined ? undefined : entry[entryKeyField];
      return typeof value === 'string' ? { entryKey: value, entry } : { entry };
    });
    return JSON.stringify({ engine, streamKey: engineStreamKey(key), entries: payload });
  };

  /**
   * Check one entries write's answer.
   *
   * The two callers spell `method:` with a **literal** rather than sharing one function that takes
   * it as a parameter, and the reason is the same one `entriesBody` gives:
   * `apps/web/server/sessions/wire-contract.test.ts` reads this file's syntax tree and learns the
   * verbs from `{ method: 'POST' }` property assignments. A verb passed through a variable is a verb
   * that gate cannot see, and an unseen verb is an unreplayed route.
   */
  const settled = async (operation: string, path: string, response: Response): Promise<void> => {
    if (response.status === 204) return;
    throw failure(operation, `${baseUrl}${path}`, response.status, await response.text());
  };

  return {
    append(key, entries) {
      return write(async () => {
        const path = entriesPath(key.sessionId);
        const response = await call('POST', path, {
          method: 'POST',
          body: entriesBody(key, entries),
          contentType: 'application/json',
        });
        return settled('POST', path, response);
      });
    },

    replaceAll(key, entries) {
      return write(async () => {
        const path = entriesPath(key.sessionId);
        const response = await call('PUT', path, {
          method: 'PUT',
          body: entriesBody(key, entries),
          contentType: 'application/json',
        });
        return settled('PUT', path, response);
      });
    },

    async load(key) {
      const collected: EngineTranscriptEntry[] = [];
      let cursor: number | null = null;
      for (;;) {
        const params = new URLSearchParams({ engine, streamKey: engineStreamKey(key) });
        params.set('limit', String(PAGE_LIMIT));
        if (cursor !== null) params.set('after', String(cursor));
        const path = `${entriesPath(key.sessionId)}?${params.toString()}`;
        const response = await call('GET', path, { method: 'GET' });
        // 404 is an answer, not a failure: the store saying this stream was never written, which is
        // exactly the `null` the port's `load()` contract asks for.
        if (response.status === 404) return null;
        if (response.status !== 200) {
          throw failure('GET', `${baseUrl}${path}`, response.status, await response.text());
        }
        const page = readEntryPage(await response.json());
        if (page === null) {
          throw new Error(
            `session state GET ${baseUrl}${path} answered 200 with a body that is not ` +
              `{ entries: [{ sequence, entryKey, entry }], nextCursor }, so the stream cannot be ` +
              `trusted to be complete.`,
          );
        }
        collected.push(...page.entries);
        if (page.nextCursor === null || page.entries.length === 0) return collected;
        cursor = page.nextCursor;
      }
    },

    delete(key) {
      return write(async () => {
        const path = `${entriesPath(key.sessionId)}?${streamQuery(key)}`;
        const response = await call('DELETE', path, { method: 'DELETE' });
        return settled('DELETE', path, response);
      });
    },

    deleteLast(key) {
      return write(async () => {
        const params = new URLSearchParams({ engine, streamKey: engineStreamKey(key) });
        params.set('last', '1');
        const path = `${entriesPath(key.sessionId)}?${params.toString()}`;
        const response = await call('DELETE', path, { method: 'DELETE' });
        return settled('DELETE', path, response);
      });
    },

    async listSubkeys(key) {
      const path = streamsPath(key.sessionId);
      const response = await call('GET', path, { method: 'GET' });
      if (response.status !== 200) {
        throw failure('GET', `${baseUrl}${path}`, response.status, await response.text());
      }
      const keys = readStreamKeys(await response.json(), engine);
      if (keys === null) {
        throw new Error(
          `session state GET ${baseUrl}${path} answered 200 with a body that is not ` +
            `{ streams: [{ engine, streamKey, updatedAt }] }.`,
        );
      }
      // Back from the store's opaque key to the Agent SDK's `subpath`. `engineStreamKey` joins the
      // two with the one character a `projectKey` cannot contain, so the split is exact; the main
      // transcript's empty suffix is dropped, because `listSubkeys` reports subagents only.
      const prefix = `${key.projectKey}/`;
      return keys
        .filter((streamKey) => streamKey.startsWith(prefix) && streamKey.length > prefix.length)
        .map((streamKey) => streamKey.slice(prefix.length))
        .sort();
    },

    putBlob(key, blobKey, bytes) {
      return write(async () => {
        if (bytes.byteLength > SESSION_STATE_BLOB_MAX_BYTES) {
          throw new Error(
            `a session-state blob of ${String(bytes.byteLength)} bytes exceeds the store's cap of ` +
              `${String(SESSION_STATE_BLOB_MAX_BYTES)}; refusing to send a request the control ` +
              `plane will answer 413 session_state_too_large.`,
          );
        }
        const params = new URLSearchParams({ engine, blobKey });
        const path = `${blobsPath(key.sessionId)}?${params.toString()}`;
        const response = await call('PUT', path, {
          method: 'PUT',
          body: bytes,
          contentType: 'application/octet-stream',
        });
        return settled('PUT', path, response);
      });
    },

    async getBlob(key, blobKey) {
      const params = new URLSearchParams({ engine, blobKey });
      const path = `${blobsPath(key.sessionId)}?${params.toString()}`;
      const response = await call('GET', path, { method: 'GET' });
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw failure('GET', `${baseUrl}${path}`, response.status, await response.text());
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    writeFailures: () => [...failures],
  };
}
