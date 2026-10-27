/**
 * The ENG-06 session-state endpoints, as plain `Request` → `Response` functions.
 *
 * ```text
 * GET    /api/sessions/:id/state-entries   listSessionStateEntries   §20 mandate
 * POST   /api/sessions/:id/state-entries   appendSessionState        §20 mandate
 * PUT    /api/sessions/:id/state-entries   replaceSessionState       §20 mandate
 * DELETE /api/sessions/:id/state-entries   deleteSessionState        §20 mandate
 * GET    /api/sessions/:id/state-streams   listSessionStateStreams   §20 mandate
 * PUT    /api/sessions/:id/state-blobs     putSessionStateBlob       §20 mandate
 * GET    /api/sessions/:id/state-blobs     getSessionStateBlob       §20 mandate
 * ```
 *
 * **Private runner routes.** Nothing in `packages/sdk`, `packages/aw` or any browser screen calls
 * one; the only client is `apps/runner/src/session.ts` with the signed per-run token. They are
 * marked as such the same way the transcript routes are — a `mandate` in
 * `tests/route-declarations/`, citing §20 — because §34 does not print them and ADR-0026 requires
 * an unprinted route to cite the section that requires the capability.
 *
 * ## Why the paths are flat and not `…/state/streams/:streamKey/entries`
 *
 * Issue #305 drew the family as `/api/sessions/:id/state/streams/:streamKey/entries`. That shape
 * is four levels deep under the resource, and ADR-0026 decision 3 — enforced by
 * `tests/route-inventory.test.ts` — stops at `/api/<resource>/:id/<sub>`: *"a fourth level is a
 * resource that has not been named"*. `subkeys` is a sibling of `transcript` today for exactly this
 * reason, and it is recorded in that route's own header. So the family keeps the shape rule and the
 * stream key travels as a query parameter, which it can because it is one opaque string. ADR-0071
 * records the decision rather than leaving it to be rediscovered.
 *
 * ## `:id` is either session identity, and the store is keyed by the platform's
 *
 * The path segment is a **UUID**, and it is resolved as `sessions.id` first and as
 * `sessions.engine_session_id` second. #305 draws the family as `/api/sessions/:id/state/…` and
 * scopes it by the run token's `sessionId` claim, which is `sessions.id`; the second lookup exists
 * because a Claude session's engine id is the same UUID (the platform hands the SDK `sessions.id` as
 * `Options.sessionId`), so a Claude adapter addressing its state by the SDK's own key reaches the same
 * row. Whichever arrives, everything after the lookup — the authorisation check, the engine
 * comparison, the storage key — uses `row.id`.
 *
 * A non-UUID `engine_session_id` is **not** accepted here, deliberately: `engine_session_id` is
 * `text`, and an engine whose own id is not a UUID (pi's JSONL name, an ACP `sessionId`) addresses
 * its state by `sessions.id`, which its adapter is given on the run request. Widening the segment is
 * a decision for the unit that lands such an engine, not a default this family guesses at.
 *
 * ## An archived session's state is refused, read or write
 *
 * `409 session_archived`, as `GET …/transcript` answers for an archived session (`./api.ts`): the
 * read is the resume path, and a session is restored before it is resumed.
 *
 * ## A Claude stream key must sit under the caller's own project key (R-01 §7)
 *
 * `streamKey` is opaque to the platform, with one exception. The Claude adapter keys a stream
 * `projectKey + '/' + subpath`, and the public `GET …/transcript` finds it under
 * `parseProjectKey(workspaceId) + '/'`. The SDK silently keys under the sanitised `cwd` when it
 * refuses `CLAUDE_CODE_PROJECT_DIR_NAME`, so on every **write** of a `claude-agent-sdk` stream a key
 * that does not begin with the principal's project key and `/` is `403 project_key_mismatch` — the
 * guard `POST …/transcript` has always had, moved with the writer. Every other engine's key stays
 * opaque. The check runs after the session is resolved and authorised, so it never answers for a
 * session the caller may not reach.
 *
 * ## A caller that may not reach a session gets 404, not 403
 *
 * Every refusal on this family is `404 session_state_not_found`, whether the session does not
 * exist, belongs to another workspace, or belongs to this workspace and not to this caller. These
 * are private runner routes reached with a token scoped to **one** session, so a 403 would answer
 * "that session exists and is not yours" to a credential that has no business learning either fact.
 * The public `/api/sessions/:id/**` family keeps its 403, because a browser user who owns no session
 * is a different conversation.
 */
import { ENGINE_CATALOGUE, type EngineId } from '@indx-workspace/contracts/engines';

import { apiError, isUuid, json, readJsonBody } from '../runs/http';
import { notConfigured, ready, sessionRepository, type Ready } from './api';
import { parseProjectKey } from './transcript';
import type { SessionRecord } from './store';
import {
  parseBlobKey,
  parseEngineId,
  parsePageLimit,
  parseSequenceCursor,
  parseSessionStateEntries,
  parseStreamKey,
  type SessionStateBlobRef,
  type SessionStateEntryPayload,
  type SessionStateStore,
  type SessionStateStreamRef,
} from './state';
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';

type ReadyState = Extract<Ready, { readonly ok: true }>;

/** The one refusal this family gives for "you cannot reach this session". See the header. */
function notFound(): Response {
  return apiError(
    404,
    'session_state_not_found',
    'no session state is addressable at this path with this credential.',
  );
}

/**
 * The blob half of the store has no byte backend in this deployment.
 *
 * 503 rather than 500 or a silent success: the entries half still works, and an operator reading
 * this needs the name of the thing that is missing, not the name of an exception.
 */
function blobsUnavailable(reason: string): Response {
  return apiError(503, 'session_state_blobs_not_configured', reason);
}

/**
 * Resolve the path segment to the platform's session row, refusing anything the caller may not
 * reach.
 *
 * Order matters and is the same everywhere in this family: resolve, then authorise, then answer.
 * Both failures answer {@link notFound}, so the order cannot be read off the status.
 */
export async function resolveSession(
  state: ReadyState,
  pathId: string,
): Promise<
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly response: Response }
> {
  if (!isUuid(pathId)) {
    return {
      ok: false,
      response: apiError(400, 'invalid_session_id', 'the session id in the path is not a UUID.'),
    };
  }
  const repository = await sessionRepository(state);
  if (repository === null) return { ok: false, response: notConfigured() };
  const row = (await repository.get(pathId)) ?? (await repository.getByEngineSessionId(pathId));
  if (row === null) return { ok: false, response: notFound() };
  // Authorised against the ROW's own id, never the path segment: a run token's claim carries
  // `runs.session_id`, which is `sessions.id`, and an engine whose session id differs from it would
  // otherwise be refused access to its own state.
  if (!(await state.env.canAccessSession(state.principal, row.id))) {
    return { ok: false, response: notFound() };
  }
  return { ok: true, session: row };
}

/**
 * Compare the engine this request declares against the engine the session is pinned to.
 *
 * `sessions.engine` is NULL until a run reports the session's identity, so a NULL is **accepted**:
 * refusing it would refuse the first write of every new session, which is the write that exists to
 * make the session resumable. What is refused is a *disagreement* — a stream claiming an engine the
 * session is already pinned to something else.
 */
function engineMismatch(session: SessionRecord, declared: EngineId): Response | null {
  if (session.engine === null || session.engine === declared) return null;
  return apiError(
    409,
    'session_engine_mismatch',
    `this session is pinned to engine ${JSON.stringify(session.engine)} and the request declares ` +
      `${JSON.stringify(declared)}. Session state is engine-scoped: one engine's state replayed ` +
      `into another is not a resume, so the write is refused rather than stored under a second engine.`,
  );
}

/**
 * Refuse a write of a `claude-agent-sdk` stream whose key is not under the principal's own project
 * key. See the header: this is R-01 §7's `project_key_mismatch`, and only Claude's keys have a
 * shape the platform knows.
 */
export function projectKeyMismatch(
  workspaceId: string,
  ref: Pick<SessionStateStreamRef, 'engine' | 'streamKey'>,
): Response | null {
  if (ENGINE_CATALOGUE[ref.engine].sessionStreamKey !== 'project-key-prefixed') return null;
  const owned = parseProjectKey(workspaceId);
  if (!owned.ok) {
    return apiError(
      500,
      'workspace_not_addressable',
      `this workspace id cannot be a projectKey, so no Claude stream of it can be stored: ${owned.reason}`,
    );
  }
  const prefix = `${owned.value}/`;
  if (ref.streamKey.startsWith(prefix)) return null;
  return apiError(
    403,
    'project_key_mismatch',
    `this request writes claude-agent-sdk stream ${JSON.stringify(ref.streamKey)} but the caller is ` +
      `scoped to projectKey ${JSON.stringify(owned.value)}, so the key must begin with ` +
      `${JSON.stringify(prefix)}. R-01 §7: the SDK falls back to a key derived from the sandbox cwd, ` +
      `silently, when it refuses the one the runner asked for — so a mismatch here is a ` +
      `misconfigured runtime, and it is refused rather than stored where the public read cannot find it.`,
  );
}

function archived(session: SessionRecord): Response | null {
  return session.status === 'archived'
    ? apiError(409, 'session_archived', 'Restore this session before reading or writing its state.')
    : null;
}

/** A query parameter, or `undefined` when absent. Absent and empty are different. */
function query(request: Request, name: string): string | undefined {
  const value = new URL(request.url).searchParams.get(name);
  return value === null ? undefined : value;
}

/** What every stream handler needs: a resolved session, a checked engine, and the stream key. */
type StreamContext = {
  readonly ok: true;
  readonly store: SessionStateStore;
  readonly session: SessionRecord;
  readonly ref: SessionStateStreamRef;
};

async function streamContext(
  state: ReadyState,
  pathId: string,
  declaredEngine: unknown,
  declaredStreamKey: unknown,
): Promise<StreamContext | { readonly ok: false; readonly response: Response }> {
  const store = state.env.stateStore;
  const engine = parseEngineId(declaredEngine);
  if (!engine.ok) return { ok: false, response: apiError(400, 'invalid_engine', engine.reason) };
  const streamKey = parseStreamKey(declaredStreamKey);
  if (!streamKey.ok) {
    return { ok: false, response: apiError(400, 'invalid_stream_key', streamKey.reason) };
  }
  const resolved = await resolveSession(state, pathId);
  if (!resolved.ok) return resolved;
  const mismatch = engineMismatch(resolved.session, engine.value);
  if (mismatch !== null) return { ok: false, response: mismatch };
  return {
    ok: true,
    store,
    session: resolved.session,
    ref: {
      // The tenant comes from the authenticated principal, never from the request. The session row
      // was resolved inside that same workspace, so the two cannot disagree.
      workspaceId: state.principal.workspaceId,
      sessionId: resolved.session.id,
      engine: engine.value,
      streamKey: streamKey.value,
    },
  };
}

/** 204 with no body, for every write on this family. */
function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

async function readEntriesBody(
  request: Request,
): Promise<
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const body = await readJsonBody(request);
  if (body.kind !== 'ok') {
    return { ok: false, response: apiError(400, 'invalid_body', body.reason) };
  }
  const payload = body.value;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      response: apiError(400, 'invalid_body', 'the request body must be a JSON object.'),
    };
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'engine' && key !== 'streamKey' && key !== 'entries') {
      return {
        ok: false,
        response: apiError(
          400,
          'invalid_body',
          `the request body carries only 'engine', 'streamKey' and 'entries'; got ${JSON.stringify(key)}.`,
        ),
      };
    }
  }
  return { ok: true, record };
}

/** Parse, resolve and authorise a write of entries. Shared by `POST` and `PUT`. */
async function writeContext(
  request: Request,
  pathId: string,
): Promise<
  | {
      readonly ok: true;
      readonly context: StreamContext;
      readonly entries: SessionStateEntryPayload[];
    }
  | { readonly ok: false; readonly response: Response }
> {
  const state = await ready(request);
  if (!state.ok) return state;
  const body = await readEntriesBody(request);
  if (!body.ok) return body;
  const context = await streamContext(
    state,
    pathId,
    body.record['engine'],
    body.record['streamKey'],
  );
  if (!context.ok) return context;
  const refused = archived(context.session);
  if (refused !== null) return { ok: false, response: refused };
  const mismatch = projectKeyMismatch(state.principal.workspaceId, context.ref);
  if (mismatch !== null) return { ok: false, response: mismatch };
  const entries = parseSessionStateEntries(body.record['entries']);
  if (!entries.ok) return { ok: false, response: apiError(400, 'invalid_entries', entries.reason) };
  return { ok: true, context, entries: entries.value };
}

/**
 * `POST /api/sessions/:id/state-entries` — append, idempotent by `entryKey`.
 *
 * 204 with no body: a resolved append means the batch is persisted, and anything returned here
 * would invite a client to believe something about ordering this API does not promise.
 */
export async function appendSessionState(request: Request, pathId: string): Promise<Response> {
  const prepared = await writeContext(request, pathId);
  if (!prepared.ok) return prepared.response;
  await prepared.context.store.append(prepared.context.ref, prepared.entries);
  return noContent();
}

/** `PUT /api/sessions/:id/state-entries` — replace every entry with exactly these. */
export async function replaceSessionState(request: Request, pathId: string): Promise<Response> {
  const prepared = await writeContext(request, pathId);
  if (!prepared.ok) return prepared.response;
  await prepared.context.store.replaceAll(prepared.context.ref, prepared.entries);
  return noContent();
}

/**
 * `GET /api/sessions/:id/state-entries?engine=&streamKey=&after=&limit=` — the cursored read.
 *
 * 404 when the store answers `null`, 200 with `entries: []` when it answers an empty array. The two
 * are different answers and only the second resumes, so collapsing them would turn "this stream has
 * no entries yet" into "this stream does not exist".
 */
export async function listSessionStateEntries(request: Request, pathId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const context = await streamContext(
    state,
    pathId,
    query(request, 'engine'),
    query(request, 'streamKey'),
  );
  if (!context.ok) return context.response;
  const refused = archived(context.session);
  if (refused !== null) return refused;
  const after = parseSequenceCursor(query(request, 'after'));
  if (!after.ok) return apiError(400, 'invalid_cursor', after.reason);
  const limit = parsePageLimit(query(request, 'limit'));
  if (!limit.ok) return apiError(400, 'invalid_limit', limit.reason);

  const entries = await context.store.list(context.ref, {
    afterSequence: after.value,
    limit: limit.value,
  });
  if (entries === null) return notFound();
  const last = entries.at(-1);
  return json(
    {
      entries,
      // Present only when this page ended on an entry, so a caller that reads to the end gets a
      // `null` rather than a cursor that would return the same empty page for ever.
      nextCursor: last === undefined ? null : last.sequence,
    },
    200,
  );
}

/**
 * `DELETE /api/sessions/:id/state-entries?engine=&streamKey=[&last=1]` — delete-last, or the stream.
 *
 * `last=1` removes exactly the highest-sequence entry (the OpenAI Agents SDK's `popItem`); without
 * it the whole stream goes (the Agent SDK's `delete(key)`). Both are 204 whether or not anything was
 * there, because a retry of a delete must not look like a failure.
 */
export async function deleteSessionState(request: Request, pathId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const context = await streamContext(
    state,
    pathId,
    query(request, 'engine'),
    query(request, 'streamKey'),
  );
  if (!context.ok) return context.response;
  const refused = archived(context.session);
  if (refused !== null) return refused;
  const mismatch = projectKeyMismatch(state.principal.workspaceId, context.ref);
  if (mismatch !== null) return mismatch;
  const last = query(request, 'last');
  if (last !== undefined && last !== '1') {
    return apiError(
      400,
      'invalid_last',
      `last=${JSON.stringify(last)} is not understood; send last=1 to remove exactly the last entry, or omit it to remove the stream.`,
    );
  }
  if (last === '1') {
    await context.store.deleteLast(context.ref);
    return noContent();
  }
  await context.store.deleteStream(context.ref);
  return noContent();
}

/**
 * `GET /api/sessions/:id/state-streams` — which streams this session has.
 *
 * The engine-neutral replacement for `…/subkeys`: an adapter resuming a session has to know which
 * streams exist before it can read them, and R-01 §7 records that a resume without that listing
 * restores the Claude main transcript and loses every subagent's.
 */
export async function listSessionStateStreams(request: Request, pathId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const store = state.env.stateStore;
  const resolved = await resolveSession(state, pathId);
  if (!resolved.ok) return resolved.response;
  const refused = archived(resolved.session);
  if (refused !== null) return refused;
  const streams = await store.listStreams({
    workspaceId: state.principal.workspaceId,
    sessionId: resolved.session.id,
  });
  return json({ streams }, 200);
}

/**
 * Read a request body as raw bytes, refusing over the cap **while streaming**.
 *
 * The limit is enforced on bytes seen, not on `Content-Length`: a header is a claim, and a check
 * that relies on it does nothing at all when the header is absent. A declared length over the cap is
 * still refused first, because reading 40 MiB to reject it is work nobody asked for.
 */
async function readBlobBytes(
  request: Request,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly response: Response }
> {
  const tooLarge = (): Response =>
    apiError(
      413,
      'session_state_too_large',
      `a session-state blob may be at most ${String(SESSION_STATE_BLOB_MAX_BYTES)} bytes, and nothing was stored.`,
    );
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      return {
        ok: false,
        response: apiError(
          400,
          'invalid_body',
          `the Content-Length header is ${JSON.stringify(declared)}, which is not a byte count.`,
        ),
      };
    }
    if (length > SESSION_STATE_BLOB_MAX_BYTES) return { ok: false, response: tooLarge() };
  }
  const body = request.body;
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      seen += chunk.byteLength;
      if (seen > SESSION_STATE_BLOB_MAX_BYTES) return { ok: false, response: tooLarge() };
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(seen);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function blobContext(
  state: ReadyState,
  request: Request,
  pathId: string,
): Promise<
  | {
      readonly ok: true;
      readonly store: SessionStateStore;
      readonly session: SessionRecord;
      readonly ref: SessionStateBlobRef;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const store = state.env.stateStore;
  const engine = parseEngineId(query(request, 'engine'));
  if (!engine.ok) return { ok: false, response: apiError(400, 'invalid_engine', engine.reason) };
  const blobKey = parseBlobKey(query(request, 'blobKey'));
  if (!blobKey.ok) {
    return { ok: false, response: apiError(400, 'invalid_blob_key', blobKey.reason) };
  }
  const resolved = await resolveSession(state, pathId);
  if (!resolved.ok) return resolved;
  const mismatch = engineMismatch(resolved.session, engine.value);
  if (mismatch !== null) return { ok: false, response: mismatch };
  return {
    ok: true,
    store,
    session: resolved.session,
    ref: {
      workspaceId: state.principal.workspaceId,
      sessionId: resolved.session.id,
      engine: engine.value,
      blobKey: blobKey.value,
    },
  };
}

/**
 * `PUT /api/sessions/:id/state-blobs?engine=&blobKey=` — store one snapshot.
 *
 * 413 `session_state_too_large` over the cap, and **nothing is stored**: the bytes are read to the
 * cap and abandoned, so a refused upload leaves neither an object nor a row. A truncated snapshot
 * would replay into an agent as a state directory its own code never wrote.
 */
export async function putSessionStateBlob(request: Request, pathId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const context = await blobContext(state, request, pathId);
  if (!context.ok) return context.response;
  const refused = archived(context.session);
  if (refused !== null) return refused;
  const body = await readBlobBytes(request);
  if (!body.ok) return body.response;
  const stored = await context.store.putBlob(context.ref, body.bytes);
  if (!stored.ok) return blobsUnavailable(stored.reason);
  return noContent();
}

/** `GET /api/sessions/:id/state-blobs?engine=&blobKey=` — read one snapshot back. */
export async function getSessionStateBlob(request: Request, pathId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const context = await blobContext(state, request, pathId);
  if (!context.ok) return context.response;
  const refused = archived(context.session);
  if (refused !== null) return refused;
  const read = await context.store.getBlob(context.ref);
  if (!read.ok) return blobsUnavailable(read.reason);
  const blob = read.content;
  if (blob === null) return notFound();
  // Copied into a `Blob` the way `apps/web/server/files/http.ts` does: a `Uint8Array` over a
  // possibly-`SharedArrayBuffer` is not a `BodyInit`, and re-wrapping is what narrows it.
  return new Response(new Blob([new Uint8Array(blob.bytes)]), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // The bytes are an engine's opaque snapshot: a browser must neither sniff nor render them.
      'x-content-type-options': 'nosniff',
      'content-disposition': 'attachment',
      'cache-control': 'no-store',
      // The digest recorded when the bytes were written, so a caller can prove it got what the
      // store recorded rather than whatever is at that object key now.
      'x-session-state-sha256': blob.sha256,
    },
  });
}
