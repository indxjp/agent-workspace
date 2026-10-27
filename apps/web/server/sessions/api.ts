/**
 * The §20 session endpoints, as plain `Request` → `Response` functions.
 *
 * ```text
 * GET    /api/sessions                                    listSessions        §34, §20
 * GET    /api/sessions/:engineSessionId/transcript        loadTranscript      §20 mandate
 * POST   /api/sessions/:engineSessionId/transcript        appendTranscript    §20 mandate
 * DELETE /api/sessions/:engineSessionId/transcript        deleteTranscript    §20 mandate
 * GET    /api/sessions/:engineSessionId/subkeys           listSubkeys        §20 mandate
 * ```
 *
 * The App Router files under `apps/web/app/api/sessions/**` are five-line adapters over these,
 * for the reason `apps/web/server/runs/api.ts` already gives: the whole surface is testable
 * without a server.
 *
 * Every handler is ordered the same way and the order is the point: **configured →
 * authenticated → well-formed → scoped → found**. Each step is a positive assertion that fails
 * closed, and a step that cannot run answers with its own status rather than falling through
 * (ADR-0015).
 *
 * ## `:engineSessionId` is the ENGINE's session id, not `sessions.id`
 *
 * Named in full in the path rather than as `:id` because the two are different identities and
 * the difference decides whether a resume works. The engine keys a transcript by the UUID it
 * reports — for the Claude Agent SDK, in `system/init`, and accepts in `resume` (R-01 §6);
 * `sessions.engine_session_id` is the column that holds it, and `sessions.id` is the platform's
 * own row id. This API is keyed on the engine's, because that is the key the store is addressed by
 * on the resume path.
 *
 * ADR-0065 renamed the column, the wire field and this path segment to `engine*`. Only the
 * segment's name changed: the URL a client calls is the same, and so is the value it carries.
 *
 * ## The scope check is the §25 lever, and it is the one that catches a silent SDK fallback
 *
 * The stored key's `projectKey` is taken from the **authenticated principal**, never from the
 * request. Issue #235 (S-21): a request that omits `projectKey` is answered under the principal's
 * own key, with no restatement required — every consumer but the runner has no reason to name a
 * key other than its own. A request that DOES state one is still parsed and still compared, and a
 * statement that disagrees with the principal is a **403 naming both** rather than a write under
 * the principal's key.
 *
 * That check exists because of a specific, silent failure mode R-01 §7 records: the SDK ignores
 * an invalid `CLAUDE_CODE_PROJECT_DIR_NAME`, or one set without `CLAUDE_CONFIG_DIR`, and keys the
 * session under the sanitised `cwd` instead — so a misconfigured runner would mirror one tenant's
 * transcript under a key derived from a filesystem path shared with every other tenant on that
 * runtime. Nothing throws when that happens. Since ENG-06 the runner writes through
 * `…/state-entries` rather than here, so the same comparison runs there too: a `claude-agent-sdk`
 * `streamKey` that does not begin with the principal's `projectKey + '/'` is a `403
 * project_key_mismatch` (`./state-api.ts`, ADR-0071). Between the two, that disagreement still stops
 * being silent.
 *
 * ## The transcript is served from the engine-scoped store first (ENG-06, ADR-0071)
 *
 * Since ENG-06 the runner writes a Claude session's transcript to the engine-scoped store
 * (`./state.ts`) and nothing writes `session_transcripts`/`session_messages` any more. So every
 * verb of this family acts on the `claude-agent-sdk` stream `projectKey + '/' + subpath` of the
 * session row, and the legacy {@link TranscriptStore} is kept only for what a pre-ENG-06 session
 * left there:
 *
 *   * `GET …/transcript` and `…/subkeys` read the stream first and fall back to the legacy store
 *     only when the stream does not exist — exactly a session no post-ENG-06 runner has written;
 *   * `POST …/transcript` appends to the stream, never to the legacy tables, so what it stores is
 *     what the next `GET` reads;
 *   * `DELETE …/transcript` removes the stream **and** the legacy rows, so the next `GET` is a 404
 *     whichever store held the transcript.
 *
 * The wire shape of all four is unchanged. The session row is resolved once per request, as
 * `sessions.id` first and `sessions.engine_session_id` second — the order `canAccessSession` uses —
 * and that one row decides both the archived refusal and the stream.
 */
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import { apiError, isUuid, json, readJsonBody } from '../runs/http';
import type { EngineId } from '@indx-workspace/contracts/engines';
import { SESSION_LIST_MAX_LIMIT } from '@indx-workspace/contracts/sessions';
import { engineStreamKey } from '@agent-workspace/engine';
import { encodeListCursor, readListCursor } from '../pagination/list-cursor';
import { applicationContext } from '../application-context';
import {
  SESSION_API_NOT_CONFIGURED_MESSAGE,
  type SessionApiEnvironment,
  type SessionApiPrincipal,
} from './environment';
import type { SessionStateStore } from './state';
import type { KeysetPosition, SessionRecord, SessionVisibility } from './store';
import {
  parseProjectKey,
  parseSubpath,
  parseTranscriptEntries,
  type TranscriptEntry,
  type TranscriptKey,
} from './transcript';

export function notConfigured(): Response {
  return apiError(503, 'session_api_not_configured', SESSION_API_NOT_CONFIGURED_MESSAGE);
}

function unauthenticated(): Response {
  return apiError(401, 'unauthenticated', 'this request carried no usable session.');
}

/** What every handler needs before it can do anything, or the response that says why it cannot. */
export type Ready =
  | {
      readonly ok: true;
      readonly env: SessionApiEnvironment;
      readonly principal: SessionApiPrincipal;
    }
  | { readonly ok: false; readonly response: Response };

/**
 * Exported for `./state-api.ts`, which is the ENG-06 half of this same family and orders its
 * handlers the same way — configured → authenticated → well-formed → scoped → found. A second copy
 * of these four lines would be a second place the 503 and the 401 could drift apart.
 */
export async function ready(request: Request): Promise<Ready> {
  const env = applicationContext()?.sessions;
  if (env === undefined) return { ok: false, response: notConfigured() };
  const principal = await env.authenticate(request);
  if (principal === null) return { ok: false, response: unauthenticated() };
  return { ok: true, env, principal };
}

async function canAccess(
  state: Extract<Ready, { readonly ok: true }>,
  sessionId: string,
): Promise<Response | null> {
  if (await state.env.canAccessSession(state.principal, sessionId)) return null;
  return apiError(
    403,
    'session_forbidden',
    'this session is not owned by the caller and the caller has no administrative session access.',
  );
}

/**
 * Build the key this request may act on, or the response refusing it.
 *
 * `declaredProjectKey` is what the caller says it is writing under. Issue #235 (S-21): an
 * **absent** `declaredProjectKey` defaults to the principal's own key — a caller that says nothing
 * is trusted to mean its own workspace. A `declaredProjectKey` that IS present is still parsed and
 * still compared, because the whole value of the field, once stated, is that it can *disagree*: a
 * misconfigured runtime that ignores its own `CLAUDE_CODE_PROJECT_DIR_NAME` (R-01 §7) sends one
 * anyway, and this is where that disagreement is still caught.
 */
function keyFor(
  principal: SessionApiPrincipal,
  engineSessionId: string,
  declaredProjectKey: unknown,
  declaredSubpath: unknown,
):
  | { readonly ok: true; readonly key: TranscriptKey }
  | { readonly ok: false; readonly response: Response } {
  if (!isUuid(engineSessionId)) {
    return {
      ok: false,
      response: apiError(
        400,
        'invalid_session_id',
        'the engine session id in the path is not a UUID, which is what the SDK’s `resume` requires (R-01 §6).',
      ),
    };
  }
  // The principal's own key is parsed too. A workspace id that could not be a projectKey is a
  // deployment defect, and answering 500 for it is more honest than storing under it anyway.
  const owned = parseProjectKey(principal.workspaceId);
  if (!owned.ok) {
    return {
      ok: false,
      response: apiError(
        500,
        'workspace_not_addressable',
        `this workspace id cannot be a projectKey, so no session of it can be stored: ${owned.reason}`,
      ),
    };
  }
  if (declaredProjectKey !== undefined) {
    const declared = parseProjectKey(declaredProjectKey);
    if (!declared.ok) {
      return { ok: false, response: apiError(400, 'invalid_project_key', declared.reason) };
    }
    if (declared.value !== owned.value) {
      return {
        ok: false,
        response: apiError(
          403,
          'project_key_mismatch',
          `this request declares projectKey ${JSON.stringify(declared.value)} but the caller is ` +
            `scoped to ${JSON.stringify(owned.value)}. R-01 §7: the SDK falls back to a key derived ` +
            `from the sandbox cwd, silently, when it refuses the one the runner asked for — so a ` +
            `mismatch here is a misconfigured runtime, not a routing detail, and it is refused ` +
            `rather than stored under the caller’s own key.`,
        ),
      };
    }
  }
  const subpath = parseSubpath(declaredSubpath);
  if (!subpath.ok) {
    return { ok: false, response: apiError(400, 'invalid_subpath', subpath.reason) };
  }
  return {
    ok: true,
    key:
      subpath.value === undefined
        ? { projectKey: owned.value, sessionId: engineSessionId }
        : { projectKey: owned.value, sessionId: engineSessionId, subpath: subpath.value },
  };
}

/** A query parameter, or `undefined` when it is absent. Absent and empty are different. */
function query(request: Request, name: string): string | undefined {
  const value = new URL(request.url).searchParams.get(name);
  return value === null ? undefined : value;
}

/**
 * Which rows `principal` may see, pushed into the query so every page is full. Mirrors
 * `canAccessSession`'s rule (see `session-rbac.ts`): a user sees the sessions owned by its exact
 * durable principal, or every session as Owner/Admin; a runner sees only the one session its
 * signed per-run claim names — matched against `engineSessionId`, since that claim carries the
 * SDK's session id, not the row's platform id. `userId` is attribution only and is null for every
 * API-key principal, so it cannot prove ownership.
 */
function visibilityOf(principal: SessionApiPrincipal): SessionVisibility {
  if (principal.kind === 'runner') {
    return { kind: 'engine-session', engineSessionId: principal.sessionId };
  }
  return principal.role === 'owner' || principal.role === 'admin'
    ? { kind: 'all' }
    : { kind: 'owner', principalId: ownerPrincipalIdOf(principal) };
}

type SessionPageQuery =
  | {
      readonly ok: true;
      readonly status: 'active' | 'archived' | undefined;
      readonly limit: number | undefined;
      readonly cursor: KeysetPosition | null;
    }
  | { readonly ok: false; readonly response: Response };

/**
 * `status`, `limit` and `cursor`, each a positive assertion. An absent `limit` is every remaining
 * row in one page — the control plane's own counting screens read the whole list — and a present
 * one is 1–{@link SESSION_LIST_MAX_LIMIT}.
 */
function parseSessionPageQuery(request: Request, workspaceId: string): SessionPageQuery {
  const params = new URL(request.url).searchParams;
  const status = params.get('status');
  if (status !== null && status !== 'active' && status !== 'archived') {
    return {
      ok: false,
      response: apiError(400, 'invalid_session_status', 'status must be active or archived.'),
    };
  }
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (
    limit !== undefined &&
    (rawLimit === '' || !Number.isInteger(limit) || limit < 1 || limit > SESSION_LIST_MAX_LIMIT)
  ) {
    return {
      ok: false,
      response: apiError(
        400,
        'invalid_limit',
        `limit must be an integer from 1 to ${String(SESSION_LIST_MAX_LIMIT)}.`,
      ),
    };
  }
  const cursor = readListCursor(params.get('cursor'), 'sessions', workspaceId);
  if (cursor.kind === 'invalid') {
    return { ok: false, response: apiError(400, 'invalid_cursor', cursor.reason) };
  }
  return {
    ok: true,
    status: status ?? undefined,
    limit,
    cursor: cursor.kind === 'ok' ? cursor.position : null,
  };
}

/**
 * `GET /api/sessions` — §20's *List sessions*, newest first by creation, cursor-paged (S-5,
 * ADR-0079). A `cursor` is bound to the caller's workspace: one minted anywhere else is a `400`.
 */
export async function listSessions(request: Request): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const owned = parseProjectKey(state.principal.workspaceId);
  if (!owned.ok) {
    return apiError(500, 'workspace_not_addressable', owned.reason);
  }
  const query = parseSessionPageQuery(request, state.principal.workspaceId);
  if (!query.ok) return query.response;
  const sessions = await state.env.sessions.forWorkspaceId(state.principal.workspaceId);
  if (sessions === null)
    return apiError(403, 'session_forbidden', 'The workspace no longer exists.');
  const page = await sessions.list({
    visibility: visibilityOf(state.principal),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    cursor: query.cursor,
  });
  return json(
    {
      sessions: page.items.map(serializeSession),
      projectKey: owned.value,
      nextCursor:
        page.nextCursor === null
          ? null
          : encodeListCursor('sessions', state.principal.workspaceId, page.nextCursor),
    },
    200,
  );
}

/** Exported for `./state-api.ts`; see {@link ready}. */
export async function sessionRepository(state: Extract<Ready, { readonly ok: true }>) {
  return state.env.sessions.forWorkspaceId(state.principal.workspaceId);
}

/** The wire shape of one session row as `GET|PATCH /api/sessions/:id` render it (`{ session }`). */
export function serializeSession(row: SessionRecord | null) {
  if (row === null) return null;
  // Mapped field by field: the pinned `agentVersionId` (#612) is server-side state the published
  // `SessionSchema` does not carry.
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    userId: row.userId,
    ownerPrincipalId: row.ownerPrincipalId,
    projectId: row.projectId,
    engineSessionId: row.engineSessionId,
    engine: row.engine,
    title: row.title,
    status: row.status,
    resumable: row.status === 'active' && row.engineSessionId !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `GET /api/sessions/:id` — complete metadata for one platform session row. */
export async function getSession(request: Request, sessionId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  if (!isUuid(sessionId))
    return apiError(400, 'invalid_session_id', 'The session id is not a UUID.');
  const forbidden = await canAccess(state, sessionId);
  if (forbidden !== null) return forbidden;
  const repository = await sessionRepository(state);
  if (repository === null) return notConfigured();
  const row = await repository.get(sessionId);
  return row === null
    ? apiError(404, 'session_not_found', 'This workspace has no session with that id.')
    : json({ session: serializeSession(row) }, 200);
}

/** `PATCH /api/sessions/:id` — title updates plus idempotent archive/restore transitions. */
export async function updateSession(request: Request, sessionId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  if (!isUuid(sessionId))
    return apiError(400, 'invalid_session_id', 'The session id is not a UUID.');
  const forbidden = await canAccess(state, sessionId);
  if (forbidden !== null) return forbidden;
  const parsed = await readJsonBody(request);
  if (
    parsed.kind !== 'ok' ||
    typeof parsed.value !== 'object' ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    return apiError(
      400,
      'invalid_body',
      parsed.kind === 'ok' ? 'The request body must be an object.' : parsed.reason,
    );
  }
  const body = parsed.value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'title' && key !== 'status')) {
    return apiError(400, 'invalid_body', 'Only title and status may be changed.');
  }
  if (
    'title' in body &&
    body['title'] !== null &&
    (typeof body['title'] !== 'string' ||
      body['title'].trim().length === 0 ||
      body['title'].length > 200)
  ) {
    return apiError(
      400,
      'invalid_title',
      'title must be null or a non-blank string of at most 200 characters.',
    );
  }
  if ('status' in body && body['status'] !== 'active' && body['status'] !== 'archived') {
    return apiError(400, 'invalid_session_status', 'status must be active or archived.');
  }
  const repository = await sessionRepository(state);
  if (repository === null) return notConfigured();
  let outcome =
    'title' in body
      ? await repository.update(sessionId, {
          title: body['title'] === null ? null : (body['title'] as string).trim(),
        })
      : await repository.update(sessionId, {});
  if (outcome.kind === 'not-found')
    return apiError(404, 'session_not_found', 'This workspace has no session with that id.');
  if (body['status'] === 'archived') outcome = await repository.archive(sessionId);
  if (body['status'] === 'active') outcome = await repository.restore(sessionId);
  if (outcome.kind === 'not-found')
    return apiError(404, 'session_not_found', 'This workspace has no session with that id.');
  return json({ session: serializeSession(outcome.session) }, 200);
}

/**
 * The session row a transcript request addresses, or `null` when there is none to consult.
 *
 * `sessions.id` first and `sessions.engine_session_id` second, the order `canAccessSession`
 * (`composition/session-rbac.ts`) and `./state-api.ts`'s `resolveSession` use: `sessions.ensure`
 * inserts with `engine_session_id` NULL and the runner writes state under `sessions.id` from its
 * first batch, so a lookup by the engine id alone misses a session in that window. Resolved once per
 * request and handed to every check that needs it.
 */
async function transcriptSessionRow(
  state: Extract<Ready, { readonly ok: true }>,
  engineSessionId: string,
): Promise<SessionRecord | null> {
  const repository = await sessionRepository(state);
  if (repository === null) return null;
  return (
    (await repository.get(engineSessionId)) ??
    (await repository.getByEngineSessionId(engineSessionId))
  );
}

function archivedTranscriptRefusal(row: SessionRecord | null): Response | null {
  return row?.status === 'archived'
    ? apiError(409, 'session_archived', 'Restore this session before resuming or appending to it.')
    : null;
}

/** The one engine whose transcript the public `…/transcript` and `…/subkeys` routes serve. */
const CLAUDE_ENGINE: EngineId = 'claude-agent-sdk';

/**
 * Where the engine-scoped store keeps this Claude session's state, or `null` when it cannot be
 * asked — no row for this id, or a row pinned to another engine. `null` sends a
 * read to the legacy store, which is the pre-ENG-06 answer.
 */
function claudeStateSession(
  state: Extract<Ready, { readonly ok: true }>,
  row: SessionRecord | null,
): {
  readonly store: SessionStateStore;
  readonly workspaceId: string;
  readonly sessionId: string;
} | null {
  const store = state.env.stateStore;
  if (row === null) return null;
  if (row.engine !== null && row.engine !== CLAUDE_ENGINE) return null;
  return { store, workspaceId: state.principal.workspaceId, sessionId: row.id };
}

/**
 * The whole of one stream, read page by page, or `null` when the stream was never written.
 *
 * Followed until a page comes back empty, because the repository caps a page and a short page is a
 * fact about that cap, not about the end of the stream.
 */
async function readWholeStream(
  store: SessionStateStore,
  ref: Parameters<SessionStateStore['list']>[0],
): Promise<TranscriptEntry[] | null> {
  const collected: TranscriptEntry[] = [];
  let afterSequence: number | undefined;
  for (;;) {
    const page = await store.list(ref, { afterSequence });
    if (page === null) return collected.length === 0 ? null : collected;
    const last = page.at(-1);
    if (last === undefined) return collected;
    // The store holds what the runner's Claude adapter appended, which is the Agent SDK's
    // `SessionStoreEntry` verbatim; the store reads no field of it and neither does this route.
    for (const one of page) collected.push(one.entry as TranscriptEntry);
    afterSequence = last.sequence;
  }
}

/**
 * `POST /api/sessions/:engineSessionId/transcript` — the SDK's `append()`, over HTTP.
 *
 * 204, with no body. The SDK's contract is that a resolved `append()` means the batch is
 * persisted; anything this endpoint returned would be read by nobody, and a body invites a client
 * to believe something about ordering that this API does not promise.
 */
export async function appendTranscript(
  request: Request,
  engineSessionId: string,
): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;

  const body = await readJsonBody(request);
  if (body.kind !== 'ok') {
    return apiError(400, 'invalid_body', body.reason);
  }
  const payload = body.value;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return apiError(400, 'invalid_body', 'the request body must be a JSON object.');
  }
  const record = payload as Record<string, unknown>;

  const key = keyFor(state.principal, engineSessionId, record['projectKey'], record['subpath']);
  if (!key.ok) return key.response;
  const forbidden = await canAccess(state, engineSessionId);
  if (forbidden !== null) return forbidden;
  const row = await transcriptSessionRow(state, engineSessionId);
  const archived = archivedTranscriptRefusal(row);
  if (archived !== null) return archived;

  const entries = parseTranscriptEntries(record['entries']);
  if (!entries.ok) return apiError(400, 'invalid_entries', entries.reason);

  const stateSession = claudeStateSession(state, row);
  if (stateSession !== null) {
    // The stream the read serves, keyed the way the runner's Claude adapter keys it: the entry's
    // `uuid` is its idempotency key, so a redelivered batch upserts in place (R-01 §7).
    await stateSession.store.append(
      {
        workspaceId: stateSession.workspaceId,
        sessionId: stateSession.sessionId,
        engine: CLAUDE_ENGINE,
        streamKey: engineStreamKey(key.key),
      },
      entries.value.map((entry) =>
        typeof entry.uuid === 'string' ? { entryKey: entry.uuid, entry } : { entry },
      ),
    );
  } else if (row !== null && row.engine !== null) {
    // Pinned to another engine: its state is not a Claude transcript, and writing one into the
    // legacy tables would be a 204 for an append no read of this session ever serves.
    return apiError(
      409,
      'session_engine_mismatch',
      `this session is pinned to engine ${JSON.stringify(row.engine)}, and a transcript is ` +
        `${JSON.stringify(CLAUDE_ENGINE)} state.`,
    );
  } else {
    // No session row for this id, so no engine-scoped stream to write to: the legacy store is
    // the only one a read of this session consults.
    await state.env.store.append(key.key, entries.value);
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/**
 * `GET /api/sessions/:engineSessionId/transcript` — the SDK's `load()`, over HTTP.
 *
 * 404 when the store answers `null`, 200 with `entries: []` when it answers an empty array. The
 * two are different answers and the SDK resumes only the second, so collapsing them into one
 * status would turn "this session has no turns yet" into "this session does not exist".
 */
export async function loadTranscript(request: Request, engineSessionId: string): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const key = keyFor(
    state.principal,
    engineSessionId,
    query(request, 'projectKey'),
    query(request, 'subpath'),
  );
  if (!key.ok) return key.response;
  const forbidden = await canAccess(state, engineSessionId);
  if (forbidden !== null) return forbidden;
  const row = await transcriptSessionRow(state, engineSessionId);
  const archived = archivedTranscriptRefusal(row);
  if (archived !== null) return archived;

  const stateSession = claudeStateSession(state, row);
  const current =
    stateSession === null
      ? null
      : await readWholeStream(stateSession.store, {
          workspaceId: stateSession.workspaceId,
          sessionId: stateSession.sessionId,
          engine: CLAUDE_ENGINE,
          streamKey: engineStreamKey(key.key),
        });
  // A session with no engine-scoped stream is one no post-ENG-06 runner wrote: pre-ENG-06 state
  // lives in the legacy tables (and 0027 copied what was there at upgrade time), so it is read
  // from there rather than answered 404.
  const entries = current ?? (await state.env.store.load(key.key));
  if (entries === null) {
    return apiError(
      404,
      'transcript_not_found',
      `no transcript is stored for session ${engineSessionId}${key.key.subpath === undefined ? '' : `/${key.key.subpath}`} in this workspace.`,
    );
  }
  return json({ entries }, 200);
}

/** `DELETE /api/sessions/:engineSessionId/transcript` — the SDK's `delete()`, over HTTP. */
export async function deleteTranscript(
  request: Request,
  engineSessionId: string,
): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const key = keyFor(
    state.principal,
    engineSessionId,
    query(request, 'projectKey'),
    query(request, 'subpath'),
  );
  if (!key.ok) return key.response;
  const forbidden = await canAccess(state, engineSessionId);
  if (forbidden !== null) return forbidden;

  // Both stores, because the read falls back per stream: removing only the stream would let the
  // next `GET` serve a pre-ENG-06 copy of the same transcript out of the legacy tables.
  const stateSession = claudeStateSession(
    state,
    await transcriptSessionRow(state, engineSessionId),
  );
  if (stateSession !== null) {
    await stateSession.store.deleteStream({
      workspaceId: stateSession.workspaceId,
      sessionId: stateSession.sessionId,
      engine: CLAUDE_ENGINE,
      streamKey: engineStreamKey(key.key),
    });
  }
  await state.env.store.delete(key.key);
  // 204 whether or not anything was there. Deletion is idempotent, and reporting 404 for a second
  // call would make a retry look like a failure.
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/**
 * `GET /api/sessions/:engineSessionId/subkeys` — the SDK's `listSubkeys()`.
 *
 * Its own route rather than a field on the transcript, because a mirror asking *"which subagent
 * transcripts exist"* must not have to download the whole main transcript to find out. R-01 §7:
 * without this, a resume restores the main transcript and loses every subagent's.
 */
export async function listTranscriptSubkeys(
  request: Request,
  engineSessionId: string,
): Promise<Response> {
  const state = await ready(request);
  if (!state.ok) return state.response;
  const key = keyFor(state.principal, engineSessionId, query(request, 'projectKey'), undefined);
  if (!key.ok) return key.response;
  const forbidden = await canAccess(state, engineSessionId);
  if (forbidden !== null) return forbidden;
  const row = await transcriptSessionRow(state, engineSessionId);
  const archived = archivedTranscriptRefusal(row);
  if (archived !== null) return archived;

  const legacy = await state.env.store.listSubkeys({
    projectKey: key.key.projectKey,
    sessionId: key.key.sessionId,
  });
  // The union of both stores, because a transcript read falls back per stream: a subkey the
  // engine-scoped store lacks is still readable from the legacy one, so it is still listed.
  const stateSession = claudeStateSession(state, row);
  const current: string[] = [];
  if (stateSession !== null) {
    // `engineStreamKey` joins with `/`, which a `projectKey` cannot contain, so the prefix is exact;
    // the main transcript's empty suffix is not a subkey.
    const prefix = engineStreamKey({ projectKey: key.key.projectKey, sessionId: engineSessionId });
    const streams = await stateSession.store.listStreams({
      workspaceId: stateSession.workspaceId,
      sessionId: stateSession.sessionId,
    });
    for (const stream of streams) {
      if (stream.engine !== CLAUDE_ENGINE || !stream.streamKey.startsWith(prefix)) continue;
      const subpath = stream.streamKey.slice(prefix.length);
      if (subpath.length > 0) current.push(subpath);
    }
  }
  const subkeys = [...new Set([...current, ...legacy])].sort();
  return json({ subkeys }, 200);
}
