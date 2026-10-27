/**
 * The hosted surface page's server half (ADR-0105; S1-17, issue #455; issue #622):
 * `POST /p/s/<name>/sessions`, the session bootstrap, its CORS preflight, the page's
 * `frame-ancestors`, and {@link readSurfacePage}, what `GET /p/s/<name>` renders from. Plain
 * functions over a `Request` and the environment, tested without a server; the route, the page
 * and the proxy are thin adapters.
 *
 * The bootstrap answers in this order, and the first refusal decides:
 *
 * 1. a query string was sent, or the body is neither empty nor a {@link SurfaceSessionRequest}
 *    → `400 invalid_body` (no option is ignored); the body is never buffered beyond
 *    {@link SESSION_BODY_MAX_BYTES};
 * 2. the name is not a surface name → `404 surface_not_found`;
 * 3. no runtime is installed → `503 surface_sessions_not_configured`;
 * 4. `mayOpenSession` refuses: the surface lists no `allowedOrigins` (or none has that name) and
 *    one of ADR-0105's four conditions fails → `404 surface_sessions_unavailable`; it lists
 *    origins and the request is from none of them → `403 surface_origin_not_allowed`; when the
 *    `production` version refuses an origin its agent's `local` draft allows (issue #733), the
 *    `403` says so, names `aw promote`, and carries CORS for that origin so its page can read it;
 * 5. no surface has that name in the environment the request is served from
 *    (`pickSurfaceVersion`), or the try page's `environment: 'local'` came on the allowed-origin
 *    branch → `404 surface_not_found`;
 * 6. the client opened too many sessions this minute → `429 surface_rate_limited`, `Retry-After`;
 * 7. the surface's workspace, agent or publisher is gone → `404 surface_not_found`;
 * 8. the requested agent is not the surface's or an offered one of the same owner →
 *    `404 surface_agent_not_offered`;
 * 9. the resume names no live session of that surface and agent with that key →
 *    `404 surface_session_not_resumable`;
 * 10. the run preflight refuses the agent → `422` with the run-start code, and no session opened;
 * 11. otherwise `201` with a {@link SurfaceSessionResponse}, carrying `resumeKey` when a new
 *     session opened.
 *
 * Every answer is `no-store` and may be framed only by this origin. Once step 4 admits a
 * cross-origin request from an allowed origin, every answer also carries
 * `Access-Control-Allow-Origin` for it; an earlier refusal never does, so a page of another origin
 * cannot even read why.
 */
import { log } from '../../telemetry/logger';
import { z } from 'zod';

import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION_HEADER,
} from '@indx-workspace/contracts';
import { NAME_KEY_PATTERN } from '@indx-workspace/contracts/project-file';
import { SecretNameSchema } from '@indx-workspace/contracts/secret-reference';
import {
  SURFACE_NAME_MAX_LENGTH,
  SURFACE_SESSION_PROBLEM_CODES,
  SurfaceSessionRequestSchema,
  SurfaceSessionResponseSchema,
  type SurfaceDefinition,
  type SurfaceSessionProblemCode,
  type SurfaceSessionRequest,
  type SurfaceSessionResponse,
} from '@indx-workspace/contracts/surfaces';

import { applicationContext } from '../../application-context';
import { formatIssues, type ApiResult } from '../../http/result';
import {
  frameAncestorsFor,
  mayOpenSession,
  type SurfaceConditionEnvironment,
  type SurfaceConditionHeaders,
} from './conditions';
import { admitSurfaceSession } from './limits';
import {
  surfaceModeOf,
  type ResolvedSurface,
  type ServedSurface,
  type SurfaceMode,
  type SurfaceModelRefusal,
  type SurfaceSessionsRuntime,
} from './runtime';

/** The installed bootstrap, or `null` while it is not `serving`. */
function surfaceSessions(): SurfaceSessionsRuntime | null {
  const surfaces = applicationContext()?.surfaces;
  return surfaces?.kind === 'serving' ? surfaces.runtime : null;
}

/** The response headers every answer of the bootstrap carries, besides `cache-control`. */
export const SURFACE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "frame-ancestors 'self'",
};

/** The headers that let `corsOrigin`'s page read an answer; none for a same-origin request. */
function corsHeaders(corsOrigin: string | null): Readonly<Record<string, string>> {
  return corsOrigin === null ? {} : { 'access-control-allow-origin': corsOrigin, vary: 'origin' };
}

function surfaceProblem(
  code: SurfaceSessionProblemCode,
  message: string,
  details?: readonly string[],
  headers: Readonly<Record<string, string>> = {},
): ApiResult {
  return {
    status: SURFACE_SESSION_PROBLEM_CODES[code],
    body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
    headers: { ...SURFACE_RESPONSE_HEADERS, ...headers },
  };
}

const SURFACE_NOT_FOUND_MESSAGE = 'No surface with that name is served here.';

/** `404 surface_not_found`: what every route under `/p/s/<name>` answers for a surface not served. */
export const surfaceNotFound = (): ApiResult =>
  surfaceProblem('surface_not_found', SURFACE_NOT_FOUND_MESSAGE);

/**
 * The largest body the bootstrap reads. A larger `Content-Length` is refused unread, and a
 * streamed body is read only until it passes this size. The largest valid
 * {@link SurfaceSessionRequest} (a uuid, a 43-character key and an agent name) is well under it.
 */
export const SESSION_BODY_MAX_BYTES = 1024;

/** A body of only JSON whitespace is no body: the slice-1 client sends none. */
const BLANK_BODY = /^[\t\n\r ]*$/u;

/** The request's body, or `null` once it passes {@link SESSION_BODY_MAX_BYTES}. */
async function readBoundedBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += chunk.value.byteLength;
      if (read > SESSION_BODY_MAX_BYTES) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type SessionRequestReading =
  | { readonly ok: true; readonly request: SurfaceSessionRequest }
  | { readonly ok: false; readonly details?: readonly string[] };

const UNREADABLE: SessionRequestReading = { ok: false };

/**
 * The bootstrap's options: no query string, and a body that is absent, blank or a strict
 * {@link SurfaceSessionRequest}. Reads at most {@link SESSION_BODY_MAX_BYTES}, then stops.
 */
async function readSessionRequest(request: Request): Promise<SessionRequestReading> {
  if (new URL(request.url).search !== '') return UNREADABLE;
  const declared = request.headers.get('content-length');
  if (
    declared !== null &&
    !(/^\d+$/u.test(declared.trim()) && Number(declared) <= SESSION_BODY_MAX_BYTES)
  ) {
    return UNREADABLE;
  }
  const bytes = request.body === null ? new Uint8Array() : await readBoundedBody(request.body);
  if (bytes === null) return UNREADABLE;
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = BLANK_BODY.test(text) ? {} : JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
  const parsed = SurfaceSessionRequestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      details: formatIssues(parsed.error.issues),
    };
  }
  return { ok: true, request: parsed.data };
}

/**
 * The query the try page puts on its widget loader, and the loader on its frame, to be served the
 * `local` working draft (issue #612).
 */
export const TRY_QUERY = 'environment=local';

/** The mode a page or loader request asks for by its `environment` query value. */
export function surfaceModeOfQuery(
  value: string | readonly string[] | null | undefined,
): SurfaceMode {
  return value === 'local' ? 'try' : 'public';
}

/** Whether `name` is in the surface name-key grammar: lower-case kebab, 1–64 characters. */
export function isSurfaceName(name: string): boolean {
  return name.length <= SURFACE_NAME_MAX_LENGTH && NAME_KEY_PATTERN.test(name);
}

/**
 * `POST /p/s/<name>/sessions`: open a session of the surface's agent and mint its token.
 *
 * The token is minted only after {@link mayOpenSession} admits the request, scoped to the one
 * session `runtime.open` opened: Lean `visitor_token_minted_only_after_open_verdict`
 * (`formal/AgentWorkspace/Theorems/Adversarial/AuthzRunToken.lean`, over `mintAfterOpen`).
 */
export async function createSurfaceSession(
  request: Request,
  name: string,
  env: SurfaceConditionEnvironment = process.env,
): Promise<ApiResult> {
  const options = await readSessionRequest(request);
  if (!options.ok) {
    return surfaceProblem(
      'invalid_body',
      'This request takes no query parameters, and a body that is empty or a session request.',
      options.details,
    );
  }
  if (!isSurfaceName(name)) return surfaceNotFound();

  const runtime = surfaceSessions();
  if (runtime === null) {
    return surfaceProblem(
      'surface_sessions_not_configured',
      'The surface session bootstrap has no runtime installed.',
    );
  }
  const mode = surfaceModeOf(options.request);
  const resolved = await runtime.resolve(name, mode);
  const verdict = mayOpenSession(
    resolved?.surface ?? null,
    request.headers,
    env,
    'session',
    resolved?.environment ?? null,
  );
  if (!verdict.ok) {
    // A public surface served from `local` is the draft itself: nothing is pending promotion.
    const pending =
      mode === 'public' && resolved?.environment !== 'local'
        ? await promotionPendingOrigin(name, request.headers, env)
        : null;
    if (pending !== null) {
      return surfaceProblem(
        'surface_origin_not_allowed',
        `This origin is listed in the draft of surface "${name}", but visitors are served its ` +
          'production version, which does not list it. Promote the draft (`aw promote`) to apply it.',
        ['promotion-pending'],
        corsHeaders(pending),
      );
    }
    return verdict.failed === 'origin-not-allowed'
      ? surfaceProblem(
          'surface_origin_not_allowed',
          'This surface may not be opened from this origin.',
        )
      : surfaceProblem(
          'surface_sessions_unavailable',
          'Surface sessions are served only by a local runtime, on loopback, to a page of the ' +
            'same origin, or to an origin the surface allows.',
          [verdict.failed],
        );
  }
  if (resolved === null || !servesMode(mode, verdict.branch)) return surfaceNotFound();
  // From here the origin is allowed, so its page may read every answer, refusals included.
  const cors = corsHeaders(verdict.corsOrigin);
  const admission = admitSurfaceSession(request.headers, Date.now(), env);
  if (!admission.admitted) {
    return surfaceProblem(
      'surface_rate_limited',
      'Too many sessions. Try again shortly.',
      undefined,
      {
        ...cors,
        'retry-after': String(admission.retryAfterSeconds),
      },
    );
  }
  const opened = await runtime.open(resolved, options.request);
  switch (opened.kind) {
    case 'gone':
      return surfaceProblem('surface_not_found', SURFACE_NOT_FOUND_MESSAGE, undefined, cors);
    case 'agent-not-offered':
      return surfaceProblem(
        'surface_agent_not_offered',
        'No agent with that name is offered by this surface.',
        undefined,
        cors,
      );
    case 'not-resumable':
      return surfaceProblem(
        'surface_session_not_resumable',
        'No session to resume matches that key.',
        undefined,
        cors,
      );
    case 'refused':
      return surfaceProblem(opened.code, opened.message, undefined, cors);
    case 'opened':
      break;
  }

  const session: SurfaceSessionResponse = SurfaceSessionResponseSchema.parse({
    token: opened.token,
    sessionId: opened.sessionId,
    agentId: opened.agentId,
    expiresAt: opened.expiresAt.toISOString(),
    ...(opened.resumeKey === null ? {} : { resumeKey: opened.resumeKey }),
  });
  return {
    status: 201,
    body: session,
    headers: { ...SURFACE_RESPONSE_HEADERS, ...cors },
  };
}

/**
 * Whether a request admitted on `branch` is served `mode` (issue #612): the try page serves the
 * `local` working draft, which only the publisher's own loopback runtime shows; a page or session
 * of an allowed origin is the public's, and is served the public surface only.
 */
function servesMode(mode: SurfaceMode, branch: 'loopback' | 'allowed-origin'): boolean {
  return mode === 'public' || branch === 'loopback';
}

/** The surface served under `name`, or `null`; a lookup that fails is logged and is `null`. */
async function resolvedSurface(name: string): Promise<ResolvedSurface | null> {
  const runtime = surfaceSessions();
  if (!isSurfaceName(name) || runtime === null) return null;
  try {
    return await runtime.resolve(name, 'public');
  } catch (error: unknown) {
    log.error(`[surfaces] the surface "${name}" could not be resolved at the edge.`, { error });
    return null;
  }
}

/**
 * The headers of the CORS preflight of `POST /p/s/<name>/sessions` (issue #622), answered `204`
 * by the proxy: a grant of `POST` with a JSON body to `Origin` only when `mayOpenSession` admits it
 * from an allowed origin, and otherwise none, so the browser refuses the request itself. No
 * credentials: the token travels in the body.
 */
export async function preflightSurfaceSession(
  name: string,
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment = process.env,
): Promise<Readonly<Record<string, string>>> {
  const served = await resolvedSurface(name);
  const verdict = mayOpenSession(
    served?.surface ?? null,
    headers,
    env,
    'session',
    served?.environment ?? null,
  );
  const corsOrigin = verdict.ok
    ? verdict.corsOrigin
    : await promotionPendingOrigin(name, headers, env);
  return preflightHeaders(corsOrigin, 'POST', 'content-type');
}

/**
 * Issue #733: the origin of a request the public surface refused but its agent's `local` draft
 * would admit, while the agent has a `production` pointer — so the draft's `allowedOrigins` is
 * not served yet — or `null`. Only an origin a version lists is ever returned, and it is granted
 * CORS solely to read the refusal that names the fix; no session opens for it. A lookup that
 * fails is logged and is `null`.
 */
async function promotionPendingOrigin(
  name: string,
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment,
): Promise<string | null> {
  const runtime = surfaceSessions();
  if (headers.get('origin') === null || !isSurfaceName(name) || runtime === null) return null;
  let draft: ResolvedSurface | null;
  try {
    draft = await runtime.resolve(name, 'try');
  } catch (error: unknown) {
    log.error(`[surfaces] the draft of surface "${name}" could not be resolved.`, { error });
    return null;
  }
  if (draft === null || !draft.promoted) return null;
  const verdict = mayOpenSession(draft.surface, headers, env, 'session');
  return verdict.ok ? verdict.corsOrigin : null;
}

/** A preflight's answer: a grant of `method` and `allowHeaders` to `corsOrigin`, or none. */
function preflightHeaders(
  corsOrigin: string | null,
  method: string,
  allowHeaders: string,
): Readonly<Record<string, string>> {
  if (corsOrigin === null) return { 'cache-control': 'no-store', vary: 'origin' };
  return {
    'cache-control': 'no-store',
    ...corsHeaders(corsOrigin),
    'access-control-allow-methods': method,
    'access-control-allow-headers': allowHeaders,
    'access-control-max-age': '600',
  };
}

/**
 * The origin the run routes a visitor token may call answer CORS for (issue #680), or `null`: the
 * request's `Origin` when `mayOpenSession` admits it, from an allowed origin, for a surface this
 * control plane serves — the bootstrap's own check, not a second one. A preflight carries no
 * token, so the grant is any served surface's origin, not only the token's own surface's; the
 * route still confines the token to its session. A lookup that fails is logged and grants nothing.
 */
async function visitorRunCors(
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment = process.env,
): Promise<string | null> {
  const runtime = surfaceSessions();
  if (headers.get('origin') === null || runtime === null) return null;
  let surfaces: readonly ServedSurface[];
  try {
    surfaces = await runtime.servedSurfaces();
  } catch (error: unknown) {
    log.error('[surfaces] the served surfaces could not be read at the edge.', { error });
    return null;
  }
  for (const surface of surfaces) {
    const verdict = mayOpenSession(surface, headers, env, 'session', surface.servedFrom ?? null);
    if (verdict.ok && verdict.corsOrigin !== null) return verdict.corsOrigin;
  }
  return null;
}

/** What a visitor run route's browser client sends besides the CORS-safelisted headers. */
const VISITOR_RUN_REQUEST_HEADERS = [
  'authorization',
  'content-type',
  'last-event-id',
  CONTRACTS_VERSION_HEADER,
].join(', ');

/** What a visitor run route's browser client reads besides the CORS-safelisted headers. */
const VISITOR_RUN_RESPONSE_HEADERS = [
  'retry-after',
  CONTRACTS_VERSION_HEADER,
  CONTRACTS_MINIMUM_VERSION_HEADER,
].join(', ');

/**
 * The preflight answer of a visitor run route that accepts `method` (issue #680): a grant only
 * for that method, to an origin {@link visitorRunCors} allows.
 */
export async function preflightVisitorRun(
  method: 'GET' | 'POST',
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment = process.env,
): Promise<Readonly<Record<string, string>>> {
  const asked = headers.get('access-control-request-method');
  const corsOrigin = asked === method ? await visitorRunCors(headers, env) : null;
  return preflightHeaders(corsOrigin, method, VISITOR_RUN_REQUEST_HEADERS);
}

/**
 * What every answer of a visitor run route adds for an origin {@link visitorRunCors} allows
 * (issue #680) — refusals included, so the widget can read a `401` or a `Retry-After` — or, when
 * nothing is granted, only `vary: origin`, so a shared cache never serves it to another origin.
 */
export async function visitorRunResponseHeaders(
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment = process.env,
): Promise<Readonly<Record<string, string>>> {
  const corsOrigin = await visitorRunCors(headers, env);
  return corsOrigin === null
    ? { vary: 'origin' }
    : {
        ...corsHeaders(corsOrigin),
        'access-control-expose-headers': VISITOR_RUN_RESPONSE_HEADERS,
      };
}

/**
 * The `content-security-policy` of `GET /p/s/<name>` (issue #622): `frame-ancestors` this origin
 * and the surface's allowed origins. An unknown surface, or one that cannot be read, is framed by
 * this origin only — it fails closed.
 */
export async function surfacePagePolicy(name: string): Promise<string> {
  return frameAncestorsFor((await resolvedSurface(name))?.surface ?? null);
}

/**
 * What `GET /p/s/<name>` and its widget loader render: the surface's name, its agent's, and the
 * parsed definition its look, layout and parts come from (ADR-0108; S1-18, issue #456).
 */
export interface SurfacePage {
  /**
   * Which `mayOpenSession` branch served it: on `loopback` the request's `Host` names this origin,
   * on `allowed-origin` the widget loader reads its own origin from its script's URL.
   */
  readonly branch: 'loopback' | 'allowed-origin';
  readonly surfaceName: string;
  readonly agentName: string;
  readonly surface: SurfaceDefinition;
  /** Whether the agent has a `production` pointer; the try page notes when it has none (#612). */
  readonly promoted: boolean;
}

/**
 * The page `GET /p/s/<name>` renders to `mode` (`try` for the try page and its widget), or `null`
 * for the page's `404`: no runtime is installed, no surface has that name in the environment
 * `mode` is served from, `mayOpenSession` refuses it in `page` mode — conditions 1–3 fail and the
 * surface lists no `allowedOrigins` — or `try` was asked on the allowed-origin branch.
 */
export async function readSurfacePage(
  name: string,
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment = process.env,
  mode: SurfaceMode = 'public',
): Promise<SurfacePage | null> {
  return (await servedSurface(name, headers, env, mode))?.page ?? null;
}

async function servedSurface(
  name: string,
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment,
  mode: SurfaceMode,
): Promise<{
  readonly runtime: SurfaceSessionsRuntime;
  readonly resolved: ResolvedSurface;
  readonly page: SurfacePage;
} | null> {
  if (!isSurfaceName(name)) return null;
  const runtime = surfaceSessions();
  if (runtime === null) return null;
  const resolved = await runtime.resolve(name, mode);
  if (resolved === null) return null;
  const verdict = mayOpenSession(resolved.surface, headers, env, 'page');
  if (!verdict.ok || !servesMode(mode, verdict.branch)) return null;
  return {
    runtime,
    resolved,
    page: {
      branch: verdict.branch,
      surfaceName: resolved.surface.name,
      agentName: resolved.agentName,
      surface: resolved.surface,
      promoted: resolved.promoted,
    },
  };
}

/** What the try page renders: the page, plus what its first message would be refused with. */
export interface TryPageData extends SurfacePage {
  /** The run preflight's refusal of the surface's agent, or `null` (issue #661). */
  readonly modelRefusal: SurfaceModelRefusal | null;
  /** The project's model secret names `aw dev` passed, or `undefined` when it passed none. */
  readonly modelSecrets: readonly string[] | undefined;
}

/** The variable `aw dev`'s local runtime carries the project's model secret names in (#661). */
const MODEL_SECRETS_VARIABLE = 'AW_LOCAL_MODEL_SECRETS';

const ModelSecretsSchema = z.array(SecretNameSchema).min(1);

/** The model secret names in `env`, names only; anything unreadable is treated as none. */
function modelSecretsOf(env: SurfaceConditionEnvironment): readonly string[] | undefined {
  const raw = env[MODEL_SECRETS_VARIABLE];
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const names = ModelSecretsSchema.safeParse(parsed);
  return names.success ? names.data : undefined;
}

/**
 * `GET /p/s/<name>/try` (issue #661): {@link readSurfacePage} in `try` mode, plus the run
 * preflight's answer for a first message, so a missing, rejected or unreachable model connection
 * is said before anything is sent. The check is the one the session bootstrap runs, discovery
 * included, so the page and the first message cannot disagree.
 */
export async function readTryPage(
  name: string,
  headers: SurfaceConditionHeaders,
  env: SurfaceConditionEnvironment = process.env,
): Promise<TryPageData | null> {
  const served = await servedSurface(name, headers, env, 'try');
  if (served === null) return null;
  return {
    ...served.page,
    modelRefusal: await served.runtime.checkModel(served.resolved),
    modelSecrets: modelSecretsOf(env),
  };
}
