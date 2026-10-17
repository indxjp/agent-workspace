/**
 * The §34 run endpoints, as plain `Request` → `Response` functions.
 *
 * ```text
 * POST /api/agents/:id/runs        startRun
 * GET  /api/runs                   listRuns          (issue #135)
 * GET  /api/runs/:id               readRun
 * GET  /api/runs/:id/events        streamRunEvents
 * POST /api/runs/:id/interrupt     interruptRun      (issue #235, S-14)
 * POST /api/runs/:id/revoke-tokens revokeRunTokens   (issue #235, S-15; same handler as the
 *                                                      deprecated POST /api/runs/:id)
 * ```
 *
 * The App Router files under `apps/web/app/api/**` are five-line adapters over these, for two
 * reasons: the whole surface is testable without a server, and §34's "expose a very small
 * control-plane API" stays legible as one file rather than as three route handlers that have to
 * be diffed against each other.
 *
 * Every handler is ordered the same way, and the order is the point: configured → authenticated
 * → well-formed → authorised → found. Each step is a positive assertion that fails closed, and a
 * step that cannot run answers with its own status rather than falling through to the next
 * (ADR-0015).
 *
 * `listRuns` and `readRun` render every item through the same {@link renderRun} (issue #135's
 * "list and detail cannot drift"), and share the same authorisation shape: `decide()` against
 * spec §21's `runs` classification in `apps/web/server/rbac/permissions.ts` — a grant of `any`
 * lists the whole workspace, and any narrower grant is enforced by filtering on the session's
 * exact owning principal, since `decide()` itself only tells a collection route that the caller "owes the
 * result set the filter" (`rbac/decide.ts`'s own comment on `not-applicable` ownership).
 * `permissions.ts` gives Owner **and Admin** `any` and Builder/Viewer `own`, so an Admin's
 * `GET /api/runs` is the workspace-wide history issue #135 asks for and `?user=<id>` is offered to
 * both roles. Admin reached `any` by issue #165, which widened that one cell and needed no edit
 * here — every branch below reads the *grant* `decide()` returned, never the role name — closing
 * gap G-7 of `docs/adr/W9-RUNS-135-durable-run-list.md`. See
 * `docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md`.
 */
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import {
  AGENT_VERSION_NUMBER_MAX,
  AGENT_VERSION_PROBLEM_CODES,
} from '@indx-workspace/contracts/agent-versions';
import {
  MODEL_PROVIDERS,
  RUN_START_PROBLEM_CODES,
  type ModelProvider,
} from '@indx-workspace/contracts/runs';
import { SURFACE_LIMIT_PROBLEM_CODES } from '@indx-workspace/contracts/surfaces';

import { upgradeEventStream } from './agent-frames';
import { digitGroup, instantOfUtcFields, isKeysetTimestamp } from '../pagination/keyset-timestamp';
import { readResumeCursor } from './cursor';
import {
  getRunApi,
  RUN_API_NOT_CONFIGURED_MESSAGE,
  type AgentRef,
  type Principal,
  type RunApiEnvironment,
  type SessionRef,
} from './environment';
import { apiError, isUuid, json, readJsonBody } from './http';
import { sseStreamResponse, type SseControlFrame, type StreamOutcome } from './sse';
import {
  isTerminalRunStatus,
  runStatuses,
  SessionBusyError,
  type ListRunsInput,
  type RunRecord,
  type RunStatus,
  type RunStore,
} from './store';
import { decide, type Ownership } from '../rbac/decide';
import type { Grant } from '../rbac/permissions';
import { parseRole } from '../rbac/roles';
import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { engineIsInstalled, engineNotInstalledMessage } from '../engines/images';
import {
  pinSessionEngine,
  publishedEngineId,
  sessionEngineMismatchMessage,
} from '../engines/session-engine';
import { enforceCeiling } from '../policy-ceiling/ceiling';

/**
 * The largest prompt one run may carry.
 *
 * The specification sets no limit. This is the smallest reading that still works: it is far above
 * any hand-typed message and far below anything that would let one unauthenticated-looking
 * request pin a control-plane process. See
 * `docs/adr/W1-CP-04-start-run-request-shape.md`.
 */
export const MAX_PROMPT_CHARS = 100_000;

/** The JSON body of `POST /api/agents/:id/runs`. */
export interface StartRunBody {
  readonly prompt: string;
  /** Continue an existing session, or omit to start one (spec §19.5 rule 4). */
  readonly sessionId: string | null;
  /**
   * Override the agent's default without mutating its definition (spec §48). Issue #129: a
   * connection and a model are supplied together or not at all — no layer of the resolution
   * ladder may mix a connection from one level with a model from another, and the run override is
   * the top of that ladder.
   */
  readonly modelOverride: { readonly connectionId: string; readonly model: string } | null;
  /** Run a new session on this numbered version instead of `local`'s (issue #697). */
  readonly version?: number;
}

export type StartRunBodyVerdict =
  | { readonly kind: 'ok'; readonly body: StartRunBody }
  | { readonly kind: 'rejected'; readonly reason: string };

const START_RUN_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'sessionId',
  'modelConnectionId',
  'model',
  'version',
]);

/**
 * Parse the start-run body. **Never throws**, and never returns `ok` for a shape it did not
 * positively recognise — an unknown key is rejected rather than ignored, for the reason
 * `packages/core/src/schemas.ts` already gives about `.strict()`: a setting the server does not
 * know how to honour, accepted silently, is a request the caller believes was obeyed.
 */
export function parseStartRunBody(input: unknown): StartRunBodyVerdict {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { kind: 'rejected', reason: 'the request body must be a JSON object' };
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!START_RUN_KEYS.has(key)) {
      return {
        kind: 'rejected',
        reason: `unknown field ${JSON.stringify(key)} in the request body`,
      };
    }
  }
  const prompt = record['prompt'];
  if (typeof prompt !== 'string') {
    return { kind: 'rejected', reason: '"prompt" is required and must be a string' };
  }
  if (prompt.trim().length === 0) {
    return { kind: 'rejected', reason: '"prompt" must not be empty' };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      kind: 'rejected',
      reason: `"prompt" is ${String(prompt.length)} characters; the maximum is ${String(MAX_PROMPT_CHARS)}`,
    };
  }
  const rawConnection = record['modelConnectionId'];
  if (rawConnection !== undefined && rawConnection !== null && !isUuid(rawConnection)) {
    return {
      kind: 'rejected',
      reason: '"modelConnectionId" must be a UUID when it is present',
    };
  }
  const rawModel = record['model'];
  if (
    rawModel !== undefined &&
    rawModel !== null &&
    (typeof rawModel !== 'string' || rawModel.length === 0)
  ) {
    return { kind: 'rejected', reason: '"model" must be a non-empty string when it is present' };
  }
  const connectionId = rawConnection ?? null;
  const model = rawModel ?? null;
  // #129: written and cleared as one pair, never one without the other — matching every other
  // configurable layer of the resolution ladder.
  if ((connectionId === null) !== (model === null)) {
    return {
      kind: 'rejected',
      reason: '"modelConnectionId" and "model" must be supplied together, or not at all',
    };
  }
  const modelOverride = connectionId === null || model === null ? null : { connectionId, model };
  const rawVersion = record['version'];
  if (
    rawVersion !== undefined &&
    (typeof rawVersion !== 'number' ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 1 ||
      rawVersion > AGENT_VERSION_NUMBER_MAX)
  ) {
    return { kind: 'rejected', reason: '"version" must be a positive integer when it is present' };
  }
  const targeting = rawVersion === undefined ? {} : { version: rawVersion };
  const rawSession = record['sessionId'];
  if (rawSession === undefined || rawSession === null) {
    return { kind: 'ok', body: { prompt, sessionId: null, modelOverride, ...targeting } };
  }
  if (!isUuid(rawSession)) {
    return { kind: 'rejected', reason: '"sessionId" must be a UUID when it is present' };
  }
  if (rawVersion !== undefined) {
    return {
      kind: 'rejected',
      reason: '"version" applies to a new session: omit "sessionId"',
    };
  }
  return { kind: 'ok', body: { prompt, sessionId: rawSession, modelOverride } };
}

/** The JSON shape a run is rendered as. Dates are ISO 8601 strings; `bigint` never appears. */
export function renderRun(run: RunRecord): Record<string, unknown> {
  const inputTokens = run.inputTokens ?? 0;
  const outputTokens = run.outputTokens ?? 0;
  const cacheReadInputTokens = run.cacheReadInputTokens ?? 0;
  const cacheCreationInputTokens = run.cacheCreationInputTokens ?? 0;
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    agentId: run.agentId,
    projectId: run.projectId ?? null,
    initiatingUserId: run.initiatingUserId ?? null,
    sessionId: run.sessionId,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
    endedAt: run.endedAt === null ? null : run.endedAt.toISOString(),
    // Derived, never stored (issue #135): a run with either timestamp missing has no duration yet,
    // which is a fact about the run and not a zero.
    durationMs:
      run.startedAt === null || run.endedAt === null
        ? null
        : run.endedAt.getTime() - run.startedAt.getTime(),
    model: run.model ?? null,
    provider: run.provider ?? null,
    modelConnectionId: run.modelConnectionId ?? null,
    // ADR-0065. `null` is reachable and meaningful: a run recorded before migration 0024 never
    // stored an engine, and saying `claude-agent-sdk` for it would be a guess dressed as a record.
    engine: run.engine ?? null,
    engineVersion: run.engineVersion ?? null,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      // Derived, never stored: the sum of every persisted counter above.
      totalTokens: inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
      toolCalls: run.toolCalls ?? 0,
    },
    cost: {
      amount: run.costUsd ?? '0.000000',
      currency: run.costCurrency ?? 'USD',
      priceTableVersion: run.priceTableVersion ?? null,
    },
    error: run.error,
    // Issue #134's ledger-recomputed aggregate. The fallback matches the column's own default;
    // both `RunStore` implementations always set it, and the field is optional on `RunRecord`
    // only because most of this interface's fields are (see that type's own comment).
    accountingState: run.accountingState ?? 'pending',
    accountingError:
      run.accountingError === undefined || run.accountingError === null
        ? null
        : 'Usage accounting could not be completed.',
  };
}

export const notConfigured = (): Response =>
  apiError(503, 'run_api_not_configured', RUN_API_NOT_CONFIGURED_MESSAGE);

export const unauthenticated = (): Response =>
  apiError(401, 'unauthenticated', 'this endpoint requires an authenticated session.');

export function requireRunPermission(
  request: Request,
  principal: Principal,
  ownership: Ownership,
): Response | null {
  const role = parseRole(principal.role);
  if (role === null)
    return apiError(403, 'forbidden', 'the authenticated identity has no recognised role.');
  const decision = decide({
    role,
    method: request.method,
    path: new URL(request.url).pathname,
    ownership,
    scope: principal.scope ?? null,
  });
  if (decision.effect === 'allow') return null;
  return apiError(
    decision.effect === 'deny' ? 403 : 500,
    decision.effect === 'deny' ? (decision.code ?? 'forbidden') : 'authorisation_undecidable',
    decision.because,
  );
}

/**
 * The row-identity half of a session-scoped browser token's grammar (issue #236, SDK-04, S-1).
 *
 * `decide()`'s scope grammar (`apps/web/server/rbac/decide.ts`) enforces which route *shapes* a
 * session scope may reach — reading a run, starting one — and, for a run scope, that the path's
 * own `:id` names the scoped row. It cannot enforce a session scope's row identity the same way:
 * on `GET /api/runs/:id`/`:id/events` the `:id` is a *run*, and on `POST /api/agents/:id/runs` it
 * is an *agent*, so in neither shape does the path itself carry the session id to compare against.
 * That comparison happens here, where the row (or the request body) is already in hand, and it
 * denies with the same `token_out_of_scope` code `decide()` uses so a caller cannot tell the two
 * halves of the same rule apart.
 */
export function requireSessionScopeMatch(
  principal: Principal,
  sessionId: string | null,
): Response | null {
  const scope = principal.scope;
  if (scope === null || scope === undefined || scope.kind !== 'session') return null;
  if (sessionId === scope.id) return null;
  return apiError(
    403,
    'token_out_of_scope',
    `this session-scoped browser token is scoped to session ${scope.id}, and ` +
      (sessionId === null
        ? 'this request names no session at all.'
        : `this request is for session ${sessionId}.`),
  );
}

/**
 * A session-scoped token's turn or rating past its surface's limits (issue #622; #606): `429` with
 * the typed code, and `Retry-After` when waiting lifts it. `null` admits it, and is the answer for
 * every other principal.
 */
export async function refuseOverVisitorLimit(
  env: RunApiEnvironment,
  principal: Principal,
  kind: 'turn' | 'feedback',
  headers: Headers,
): Promise<Response | null> {
  const scope = principal.scope;
  if (env.admitVisitorWrite === undefined || scope?.kind !== 'session') return null;
  const refusal = await env.admitVisitorWrite(principal.workspaceId, scope.id, kind, headers);
  if (refusal === null) return null;
  const response = apiError(
    SURFACE_LIMIT_PROBLEM_CODES[refusal.code],
    refusal.code,
    refusal.message,
  );
  if (refusal.retryAfterSeconds !== null) {
    response.headers.set('retry-after', String(refusal.retryAfterSeconds));
  }
  return response;
}

const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

/**
 * Issue #535: a run's explicit `modelOverride` outside the deployment ceiling's `models` answers
 * `403 policy_cannot_widen` before any session or run exists. Only the override is judged here,
 * against a ceiling reduced to `models`, so `model:<id>` is the only detail; the stored engine and
 * the ladder-resolved model are preflight's (S2-04c, `RUN_START_PROBLEM_CODES`), so the two never
 * refuse the same field twice.
 */
async function modelOverrideRefusal(
  request: Request,
  env: RunApiEnvironment,
  principal: Principal,
  agent: AgentRef,
  body: StartRunBody,
): Promise<Response | null> {
  const override = body.modelOverride;
  const ceiling = env.ceilingFor?.(request, principal.workspaceId);
  const models = ceiling?.policy.models;
  if (override === null || ceiling === undefined || models === undefined) return null;
  const refused = await enforceCeiling(
    {
      permissions: NO_PERMISSIONS,
      limits: { maxTurns: null, maxBudgetUsd: null },
      engine: publishedEngineId(agent.engine),
      model: override.model,
      tools: [],
    },
    { ...ceiling, policy: { models } },
    { id: agent.id, label: 'run start' },
  );
  return refused === null ? null : json(refused.body, RUN_START_PROBLEM_CODES.policy_cannot_widen);
}

/** A start {@link startRunOnSession} refused, with the status and code `startRun` answers. */
interface RunStartRefused {
  readonly kind: 'refused';
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type RunOnSessionStart =
  | { readonly kind: 'started'; readonly run: RunRecord; readonly session: SessionRef }
  | RunStartRefused;

const refused = (status: number, code: string, message: string): RunStartRefused => ({
  kind: 'refused',
  status,
  code,
  message,
});

/**
 * Start one run of `agent` for `principal`: the preflight, the session, the engine pin, the run row
 * and the launch. The one run starter behind `POST /api/agents/:id/runs` and the evaluation
 * handler (issue #618), so both meet the same refusals. The caller has already authenticated and
 * authorised the principal and found the agent; a refusal creates no run and opens no new session.
 * `agentVersionId` pins a new session to that version rather than `local`'s (issue #618).
 */
export async function startRunOnSession(
  env: RunApiEnvironment,
  principal: Principal,
  agent: AgentRef,
  input: StartRunBody & { readonly agentVersionId?: string },
): Promise<RunOnSessionStart> {
  // Issue #393: a run whose agent has no runtime profile, or whose model cannot resolve, is refused
  // with a code that names the missing piece, before `store.create`. A run that would open a new
  // session is checked before `openSession` too (PR #403 review), so a refused first message leaves
  // no empty session behind. A follow-up in an existing session is checked below, once the session
  // is known to be usable, because its project default depends on that session.
  const checkRunStart = async (sessionId: string | null): Promise<RunStartRefused | null> => {
    const refusal =
      env.preflight === undefined
        ? null
        : await env.preflight(
            principal,
            agent,
            sessionId,
            input.modelOverride,
            sessionId === null ? input.agentVersionId : undefined,
          );
    return refusal === null
      ? null
      : refused(RUN_START_PROBLEM_CODES[refusal.code], refusal.code, refusal.message);
  };
  // Every refusal a run that opens its own session can meet is decided before that session is
  // opened (PR #403 review): the preflight, and the engine image a new session would pin
  // (`pinSessionEngine` gives a session with no engine the agent's). So the only sessions this route
  // creates are ones a run is then created in, and it never deletes a session — a session a client
  // opened itself (`projects.startSession`) stays the client's, refused start or not.
  if (input.sessionId === null) {
    const refusal = await checkRunStart(null);
    if (refusal !== null) return refusal;
    const fresh = pinSessionEngine({ sessionEngine: null, agentEngine: agent.engine });
    if (fresh.kind === 'pinned' && !engineIsInstalled(fresh.engine)) {
      return refused(422, 'engine_not_installed', engineNotInstalledMessage(fresh.engine));
    }
  }

  const session = await env.openSession(
    principal,
    agent,
    input.sessionId,
    input.sessionId === null ? input.agentVersionId : undefined,
  );
  if (session === null) {
    return refused(
      409,
      'session_not_usable',
      'the requested session cannot run this agent; omit sessionId to start a new session (spec §19.5 rule 4).',
    );
  }

  // ADR-0065 D8: a session stays on the engine it started with. Checked *before* `store.create`,
  // so a refused run leaves no row behind — a queued run that can never be launched is worse than
  // no run, because it is indistinguishable from one the runtime has not reached yet.
  // A pinned session runs its version's engine, which may not be the agent row's (issue #612).
  const pin = pinSessionEngine({
    sessionEngine: session.engine,
    agentEngine: session.versionEngine ?? agent.engine,
  });
  if (pin.kind === 'mismatch') {
    return refused(409, 'session_engine_mismatch', sessionEngineMismatchMessage(pin));
  }

  // ENG-07 (#306): a run needs a sandbox, and a sandbox needs an image that carries this engine's
  // adapter. Checked here — after the engine is pinned and *before* `store.create` — for the reason
  // the pin above is: a queued run that can never be launched is worse than no run, because it is
  // indistinguishable from one the runtime has not reached yet. `installed` on `GET /api/engines`
  // reads the same map, so a client that checked the catalogue first never sees this.
  if (!engineIsInstalled(pin.engine)) {
    return refused(422, 'engine_not_installed', engineNotInstalledMessage(pin.engine));
  }

  // The follow-up's preflight (see `checkRunStart` above), before `store.create` for the reason the
  // two checks above give.
  if (input.sessionId !== null) {
    const refusal = await checkRunStart(session.id);
    if (refusal !== null) return refusal;
  }

  let run: RunRecord;
  try {
    run = await env.store.create({
      id: crypto.randomUUID(),
      workspaceId: principal.workspaceId,
      agentId: agent.id,
      sessionId: session.id,
      initiatingUserId: principal.userId,
      ownerPrincipalId: ownerPrincipalIdOf(principal),
      // The engine the session is pinned to, or — for a session this run is the first of — the
      // one the agent's policy names. A record, never a default (ADR-0065).
      engine: pin.engine,
      prompt: input.prompt,
    });
  } catch (error) {
    // Two runs resuming one engine session would interleave its transcript.
    if (!(error instanceof SessionBusyError)) throw error;
    return refused(
      409,
      'session_busy',
      'this session already has a run in progress; wait for it to finish or interrupt it.',
    );
  }
  env.launch({
    run,
    agent,
    session,
    principal,
    prompt: input.prompt,
    modelOverride: input.modelOverride,
  });
  return { kind: 'started', run, session };
}

/** POST /api/agents/:id/runs */
export async function startRun(request: Request, agentId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();

  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(agentId)) {
    return apiError(400, 'invalid_agent_id', 'the agent id in the path is not a UUID.');
  }
  // issue #117 (W9-AUTH-117, declared out-of-globs on that task's PR): agents now carry
  // `created_by` and `agent_grants` exists, so ownership is real rather than always `'unknown'`.
  const ownership = await resolveAgentRunOwnership(principal, agentId);
  const permission = requireRunPermission(request, principal, ownership);
  if (permission !== null) return permission;

  const raw = await readJsonBody(request);
  if (raw.kind !== 'ok') return apiError(400, 'invalid_body', raw.reason);
  const parsed = parseStartRunBody(raw.value);
  if (parsed.kind !== 'ok') return apiError(400, 'invalid_body', parsed.reason);
  // §3.1's session scope: "start runs in that session", never a new one and never another. A body
  // that omits `sessionId` is refused the same way a body naming a different session is, rather
  // than silently starting a fresh session the token was never scoped to.
  const scopeMismatch = requireSessionScopeMatch(principal, parsed.body.sessionId);
  if (scopeMismatch !== null) return scopeMismatch;
  const overLimit = await refuseOverVisitorLimit(env, principal, 'turn', request.headers);
  if (overLimit !== null) return overLimit;

  // A follow-up's agent carries its conversation's pinned engine (issue #612), which the model
  // override's ceiling check below and the engine pin in `startRunOnSession` read.
  const agent = await env.findAgent(principal, agentId, parsed.body.sessionId);
  // 404 rather than 403 when the agent belongs to another workspace: §25's isolation rule is not
  // satisfied by a status code that confirms the row exists.
  if (agent === null) {
    return apiError(404, 'agent_not_found', `no agent ${agentId} in this workspace.`);
  }

  const overCeiling = await modelOverrideRefusal(request, env, principal, agent, parsed.body);
  if (overCeiling !== null) return overCeiling;

  // Issue #697: a named version is looked up in the principal's workspace, so another workspace's
  // number is as unknown as one that was never saved.
  let agentVersionId: string | undefined;
  if (parsed.body.version !== undefined) {
    const found = await env.findAgentVersion?.(principal, agent.id, parsed.body.version);
    if (found === undefined || found === null) {
      return apiError(
        AGENT_VERSION_PROBLEM_CODES.agent_version_not_found,
        'agent_version_not_found',
        `the agent has no version ${String(parsed.body.version)}.`,
      );
    }
    agentVersionId = found.id;
  }

  const started = await startRunOnSession(
    env,
    principal,
    agent,
    agentVersionId === undefined ? parsed.body : { ...parsed.body, agentVersionId },
  );
  if (started.kind === 'refused') {
    return apiError(started.status, started.code, started.message);
  }
  const { run } = started;

  // 202, not 201: the run is accepted and queued, and what the caller actually wants is the
  // stream, whose URL is in the body and in Location.
  const events = `/api/runs/${run.id}/events`;
  return json({ run: renderRun(run), events }, 202, { Location: events });
}

/**
 * Look a run up and confirm it belongs to this principal's workspace.
 *
 * Returns `null` for "no such run" and for "not yours" alike, and both become a 404. §25's
 * isolation is not satisfied by a status code that tells a caller the row exists.
 */
export async function findRunForPrincipal(
  store: RunStore,
  principal: Principal,
  runId: string,
): Promise<RunRecord | null> {
  const run = await store.get(runId);
  if (run === null) return null;
  return run.workspaceId === principal.workspaceId ? run : null;
}

/** GET /api/runs/:id */
export async function readRun(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(runId)) {
    return apiError(400, 'invalid_run_id', 'the run id in the path is not a UUID.');
  }
  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);
  const scopeMismatch = requireSessionScopeMatch(principal, run.sessionId);
  if (scopeMismatch !== null) return scopeMismatch;
  const permission = requireRunPermission(
    request,
    principal,
    (await env.ownsRun(principal, run)) ? 'own' : 'other',
  );
  if (permission !== null) return permission;
  return json({ run: renderRun(run) }, 200);
}

// ── GET /api/runs — issue #135 ──────────────────────────────────────────────────────────────

/** The default page size when `limit` is omitted. */
const DEFAULT_RUN_LIST_LIMIT = 20;
/** The largest page a caller may request. Matches `MAX_RUN_LIST_LIMIT` in the core repository. */
const MAX_RUN_LIST_LIMIT = 200;

/**
 * A `(created_at, id)` pagination boundary, opaque to every client: base64url of a small JSON
 * object. Never a raw offset — an offset is exactly what stops being stable the moment a row is
 * inserted or deleted ahead of it, which is the property issue #135 asks this pagination to have.
 *
 * `cursor.createdAt` is carried through **as the string the store minted it as** — never parsed
 * into, or built from, a `Date`. `./store.ts`'s `RunListCursor` doc comment says why: a `Date`
 * only survives to millisecond precision, `runs.created_at` is microsecond precision, and this
 * function used to call `.toISOString()` here, which is exactly where round 2 finding 1's
 * truncation happened — silently, on every single cursor this route ever minted.
 */
function encodeRunListCursor(cursor: { readonly createdAt: string; readonly id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * The exact text a `from`/`to` query parameter may take: `YYYY-MM-DDTHH:MM:SS`, an optional
 * fractional part of one to three digits, then a mandatory zone — `Z` or `±HH:MM`. Three digits
 * because a `Date` (the type both stores compare against) carries nothing finer, and a fourth
 * digit silently dropped would move `from` onto rows the caller asked to exclude. A mandatory
 * zone because a zone-less timestamp is read in the web process's own time zone, so the same
 * request answered different rows on instances configured differently (round 4 finding 5).
 */
const RUN_LIST_BOUND =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * The instants a `from`/`to` bound may name: years 0001–9999 UTC. PostgreSQL reads further in
 * both directions, but every `Date` the query binds is serialised by `toISOString`, which prints
 * a year outside that range in the signed six-digit form (`+010000-…`) PostgreSQL refuses — the
 * cause of round 4 finding 2's thrown queries. Checked on the UTC instant, after any offset is
 * applied, because `9999-12-31T23:00:00-02:00` is already year 10000.
 */
const EARLIEST_RUN_LIST_BOUND = ((): number => {
  const instant = new Date(0);
  instant.setUTCFullYear(1, 0, 1);
  instant.setUTCHours(0, 0, 0, 0);
  return instant.getTime();
})();
const LATEST_RUN_LIST_BOUND = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** The one sentence `invalid_from` and `invalid_to` both explain the shape with. */
const RUN_LIST_BOUND_REQUIREMENT =
  'must be an ISO-8601 timestamp with an explicit zone (YYYY-MM-DDTHH:MM:SS[.fff]Z or ' +
  '±HH:MM) in years 0001–9999.';

/**
 * Parse a `from`/`to` query parameter, or `null` for anything outside {@link RUN_LIST_BOUND} and
 * {@link EARLIEST_RUN_LIST_BOUND}–{@link LATEST_RUN_LIST_BOUND}. A positive assertion in the
 * ADR-0015 shape: the value is admitted because it names an instant the query can bind, never
 * because `new Date(text)` happened not to be `NaN` — that gate admitted `"1"`, `"2026"`, a
 * signed six-digit year, year 0 and a zone-less timestamp (round 4 findings 2 and 5).
 */
function parseRunListBound(text: string): Date | null {
  const match = RUN_LIST_BOUND.exec(text);
  if (match === null) return null;
  const fraction = match[7];
  const utc = instantOfUtcFields({
    year: digitGroup(match, 1),
    month: digitGroup(match, 2),
    day: digitGroup(match, 3),
    hour: digitGroup(match, 4),
    minute: digitGroup(match, 5),
    second: digitGroup(match, 6),
    millisecond: fraction === undefined ? 0 : Number(fraction.padEnd(3, '0')),
  });
  if (utc === null) return null;
  let offsetMinutes = 0;
  if (match[8] === undefined) {
    // Not `Z`, so the `±HH:MM` alternative matched and all three of its groups are present.
    const sign = match[9];
    if (sign === undefined) throw new Error('timestamp zone sign is absent');
    const hours = digitGroup(match, 10);
    const minutes = digitGroup(match, 11);
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (sign === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  const instant = utc.getTime() - offsetMinutes * 60_000;
  if (instant < EARLIEST_RUN_LIST_BOUND || instant > LATEST_RUN_LIST_BOUND) return null;
  return new Date(instant);
}

type CursorParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly cursor: { readonly createdAt: string; readonly id: string } }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Decode a `cursor` query parameter. **Never falls back to "start over"**: the same ADR-0015
 * shape `./cursor.ts`'s resume cursor uses — a malformed cursor a client believes is valid must be
 * refused by name, not silently answered with page one re-served as if it were the next page.
 */
function decodeRunListCursor(raw: string | null): CursorParseResult {
  if (raw === null) return { kind: 'absent' };
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return { kind: 'invalid', reason: 'the cursor is not valid base64url.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'the cursor does not decode to JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'the cursor must decode to a JSON object.' };
  }
  const record = value as Record<string, unknown>;
  const createdAtRaw = record['createdAt'];
  const id = record['id'];
  if (typeof createdAtRaw !== 'string' || !isUuid(id)) {
    return {
      kind: 'invalid',
      reason: 'the cursor must carry a "createdAt" timestamp string and an "id" UUID.',
    };
  }
  // Validated against the exact shape the stores mint, and then passed on as the raw string, at
  // whatever precision the minting store actually used — never re-rendered through a `Date`.
  if (!isKeysetTimestamp(createdAtRaw)) {
    return {
      kind: 'invalid',
      reason:
        'the cursor "createdAt" is not a UTC timestamp of the form YYYY-MM-DDTHH:MM:SS.ffffffZ.',
    };
  }
  return { kind: 'ok', cursor: { createdAt: createdAtRaw, id } };
}

type RunListAccess =
  | { readonly kind: 'allowed'; readonly grant: Grant }
  | { readonly kind: 'denied'; readonly response: Response };

/**
 * `decide()` against spec §21's `runs` classification, exactly as {@link requireRunPermission}
 * does for the single-run routes, plus the one extra fact a collection route needs and a
 * single-row route does not: the grant's *width*. `not-applicable` is this route's honest
 * ownership answer — §34 names no single row here — and `decide()`'s own contract for that pair
 * (`rbac/decide.ts`'s comment on `applyGrant`'s `own` arm) is that the width is returned so the
 * caller can filter the result set itself, which {@link parseRunListQuery} then does.
 */
function decideRunListAccess(request: Request, principal: Principal): RunListAccess {
  const role = parseRole(principal.role);
  if (role === null) {
    return {
      kind: 'denied',
      response: apiError(403, 'forbidden', 'the authenticated identity has no recognised role.'),
    };
  }
  const decision = decide({
    role,
    method: request.method,
    path: new URL(request.url).pathname,
    ownership: 'not-applicable',
    scope: principal.scope ?? null,
  });
  // Unreachable today (round 2 finding 4, gap G-8): every role in `permissions.ts` has `read:
  // 'own'` or `'any'` on `runs`, so `decide()` never returns anything but `allow` here. Kept, and
  // left untested, rather than deleted — this is the same fail-closed shape every other route's
  // authorisation check uses, and `permissions.ts` (outside this task's `Owns` globs) is the only
  // file that could ever make a role take this branch.
  if (decision.effect !== 'allow') {
    return {
      kind: 'denied',
      response: apiError(
        decision.effect === 'deny' ? 403 : 500,
        decision.effect === 'deny' ? (decision.code ?? 'forbidden') : 'authorisation_undecidable',
        decision.because,
      ),
    };
  }
  if (decision.facts === null) {
    // `facts` is null only for `decide()`'s public surface, and `/api/runs` is never that —
    // reported rather than assumed away (ADR-0015).
    throw new Error('GET /api/runs was allowed with no route facts to read the grant from.');
  }
  return { kind: 'allowed', grant: decision.facts.grant };
}

type RunListQueryResult =
  | { readonly kind: 'ok'; readonly input: ListRunsInput }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly reason: string;
    };

/**
 * Parse and validate every `GET /api/runs` query parameter, including the authorisation rule
 * issue #135 states as a "deliberately not built": the `user` filter exists only for a caller
 * whose grant is `any` (Owner and Admin, under the current `runs` classification — see this
 * file's header).
 * A grant of `own` gets the same filter applied, but as an unconditional fact about the query
 * rather than an offered parameter: {@link decideRunListAccess} already established that this
 * caller may only ever see their own rows, so nothing here trusts the caller to ask correctly.
 */
function parseRunListQuery(url: URL, grant: Grant, principal: Principal): RunListQueryResult {
  const params = url.searchParams;
  const reject = (status: number, code: string, reason: string): RunListQueryResult => ({
    kind: 'rejected',
    status,
    code,
    reason,
  });

  const rawLimit = params.get('limit');
  let limit = DEFAULT_RUN_LIST_LIMIT;
  if (rawLimit !== null) {
    if (!/^[1-9]\d{0,3}$/.test(rawLimit)) {
      return reject(400, 'invalid_limit', 'limit must be a positive integer.');
    }
    limit = Number(rawLimit);
    if (limit > MAX_RUN_LIST_LIMIT) {
      return reject(400, 'invalid_limit', `limit must not exceed ${String(MAX_RUN_LIST_LIMIT)}.`);
    }
  }

  const cursor = decodeRunListCursor(params.get('cursor'));
  if (cursor.kind === 'invalid') return reject(400, 'invalid_cursor', cursor.reason);

  const filter: {
    status?: RunStatus;
    agentId?: string;
    projectId?: string;
    provider?: ModelProvider;
    model?: string;
    createdFrom?: Date;
    createdTo?: Date;
    initiatingUserId?: string;
    ownerPrincipalId?: string;
  } = {};

  const status = params.get('status');
  if (status !== null) {
    if (!(runStatuses as readonly string[]).includes(status)) {
      return reject(400, 'invalid_status', `status must be one of: ${runStatuses.join(', ')}.`);
    }
    filter.status = status as RunStatus;
  }

  const agent = params.get('agent');
  if (agent !== null) {
    if (!isUuid(agent)) return reject(400, 'invalid_agent', 'agent must be a UUID.');
    filter.agentId = agent;
  }

  const project = params.get('project');
  if (project !== null) {
    if (!isUuid(project)) return reject(400, 'invalid_project', 'project must be a UUID.');
    filter.projectId = project;
  }

  const provider = params.get('provider');
  if (provider !== null) {
    if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
      return reject(
        400,
        'invalid_provider',
        `provider must be one of: ${MODEL_PROVIDERS.join(', ')}.`,
      );
    }
    filter.provider = provider as ModelProvider;
  }

  const model = params.get('model');
  if (model !== null) {
    if (model.trim().length === 0) return reject(400, 'invalid_model', 'model must not be empty.');
    filter.model = model;
  }

  const from = params.get('from');
  if (from !== null) {
    const createdFrom = parseRunListBound(from);
    if (createdFrom === null) {
      return reject(400, 'invalid_from', `from ${RUN_LIST_BOUND_REQUIREMENT}`);
    }
    filter.createdFrom = createdFrom;
  }

  const to = params.get('to');
  if (to !== null) {
    const createdTo = parseRunListBound(to);
    if (createdTo === null) return reject(400, 'invalid_to', `to ${RUN_LIST_BOUND_REQUIREMENT}`);
    if (filter.createdFrom !== undefined && createdTo.getTime() < filter.createdFrom.getTime()) {
      return reject(400, 'invalid_date_range', 'to must not be before from.');
    }
    filter.createdTo = createdTo;
  }

  const user = params.get('user');
  if (user !== null) {
    if (grant !== 'any') {
      return reject(
        403,
        'user_filter_forbidden',
        'the "user" filter is available only to a role with workspace-wide run read access.',
      );
    }
    if (!isUuid(user)) return reject(400, 'invalid_user', 'user must be a UUID.');
    filter.initiatingUserId = user;
  } else if (grant !== 'any') {
    // `decide()`'s own words for `own` on a collection route: the caller "owes the result set the
    // filter" (`rbac/decide.ts`). Paid unconditionally, so a Builder or Viewer request can never
    // widen past their own runs no matter what else it asks for.
    filter.ownerPrincipalId = ownerPrincipalIdOf(principal);
  }

  return {
    kind: 'ok',
    input: { filter, limit, cursor: cursor.kind === 'ok' ? cursor.cursor : null },
  };
}

/**
 * GET /api/runs — a workspace-scoped, filtered, cursor-paginated run list (issue #135). Every
 * item is rendered by the exact {@link renderRun} `readRun` uses, so list and detail cannot drift.
 */
export async function listRuns(request: Request): Promise<Response> {
  const env = getRunApi();
  if (env === null || env.store.listRuns === undefined) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();

  const access = decideRunListAccess(request, principal);
  if (access.kind === 'denied') return access.response;

  const query = parseRunListQuery(new URL(request.url), access.grant, principal);
  if (query.kind === 'rejected') return apiError(query.status, query.code, query.reason);

  const page = await env.store.listRuns(principal.workspaceId, query.input);
  return json(
    {
      runs: page.items.map(renderRun),
      nextCursor: page.nextCursor === null ? null : encodeRunListCursor(page.nextCursor),
    },
    200,
  );
}

/** POST /api/runs/:id — owner/admin on-demand revocation of one or all run tokens. */
export async function revokeRunTokens(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null || env.revokeRunTokens === undefined) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  const permission = requireRunPermission(request, principal, 'not-applicable');
  if (permission !== null) return permission;
  if (!isUuid(runId)) {
    return apiError(400, 'invalid_run_id', 'the run id in the path is not a UUID.');
  }
  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);

  const raw = await readJsonBody(request);
  if (raw.kind !== 'ok') return apiError(400, 'invalid_body', raw.reason);
  if (raw.value === null || typeof raw.value !== 'object' || Array.isArray(raw.value)) {
    return apiError(400, 'invalid_body', 'the request body must be a JSON object.');
  }
  const record = raw.value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'tokenId')) {
    return apiError(400, 'invalid_body', 'only tokenId may be supplied.');
  }
  const tokenId = record['tokenId'] ?? null;
  if (tokenId !== null && !isUuid(tokenId)) {
    return apiError(400, 'invalid_token_id', 'tokenId must be a UUID or null.');
  }
  const result = await env.revokeRunTokens(principal, runId, tokenId);
  return json(result, 200);
}

/**
 * Stop `run`, which the caller has already found and authorised: `'terminal'` when it had already
 * finished (nothing is interrupted), `'stopped'` after the interrupt was handed to the runtime.
 * The one interrupt path behind `POST /api/runs/:id/interrupt` and A2A `tasks/cancel`.
 */
export async function interruptRunFor(
  env: RunApiEnvironment,
  principal: Principal,
  run: RunRecord,
): Promise<'stopped' | 'terminal'> {
  if (isTerminalRunStatus(run.status)) return 'terminal';
  if (env.interruptRun === undefined) throw new Error('the run API has no interruptRun installed');
  await env.interruptRun(principal, run);
  return 'stopped';
}

/**
 * POST /api/runs/:id/interrupt — issue #235 (S-14). Stop a run this principal may run.
 *
 * Ordered exactly like every other handler in this file (this file's own header): configured →
 * authenticated → well-formed → found → authorised → not-already-terminal → act → re-read. Found
 * before authorised, via {@link findRunForPrincipal}, so a run in another workspace answers the
 * same `404` a nonexistent one does (§25) rather than a `403` that would confirm it exists.
 */
export async function interruptRun(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null || env.interruptRun === undefined) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(runId)) {
    return apiError(400, 'invalid_run_id', 'the run id in the path is not a UUID.');
  }
  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);
  const permission = requireRunPermission(
    request,
    principal,
    (await env.ownsRun(principal, run)) ? 'own' : 'other',
  );
  if (permission !== null) return permission;
  if ((await interruptRunFor(env, principal, run)) === 'terminal') {
    return apiError(
      409,
      'run_not_interruptible',
      `run ${runId} is already ${run.status} and cannot be interrupted.`,
    );
  }
  // Re-read rather than trust the request: the response reports the status the store actually
  // holds, which is what a follower observing `run.status` will also see.
  const settled = await findRunForPrincipal(env.store, principal, runId);
  return json({ run: renderRun(settled ?? run) }, 200);
}

/**
 * How a client learns that a run did not succeed.
 *
 * Total over {@link RunRecord.status}: every status has an arm, an absent record has an arm, and
 * the `default` reports rather than assumes. Only `completed` returns `succeeded`, which is the
 * only arm that lets the stream end with a bare `done` — a run is treated as successful because
 * its record says `completed`, never because nothing said otherwise (ADR-0015).
 *
 * `queued`/`running` are reachable when the subscription was closed before the run reached a
 * terminal status — a client disconnect, or a teardown. The stream is over either way, so the
 * client is told the outcome is unknown rather than told the run is over.
 */
export function classifyRunOutcome(run: RunRecord | null, runId: string): StreamOutcome {
  if (run === null) {
    return {
      kind: 'indeterminate',
      reason: `run ${runId} is no longer readable; its outcome is unknown to this connection`,
    };
  }
  switch (run.status) {
    case 'completed':
      return { kind: 'succeeded' };
    case 'failed':
      return {
        kind: 'failed',
        status: 'failed',
        message: run.error ?? `run ${runId} failed and recorded no message`,
      };
    case 'cancelled':
      return {
        kind: 'failed',
        status: 'cancelled',
        message: run.error ?? `run ${runId} was cancelled`,
      };
    case 'queued':
    case 'running':
      return {
        kind: 'indeterminate',
        reason: `the stream for run ${runId} ended while the run was still ${run.status}; its outcome is unknown to this connection`,
      };
    default: {
      // Unreachable while `RunStatus` and this switch agree; a new status added to one and not
      // the other lands here and is reported, not silently treated as a success.
      const unhandled: never = run.status;
      return {
        kind: 'indeterminate',
        reason: `run ${runId} has a status this server does not recognise: ${String(unhandled)}`,
      };
    }
  }
}

/**
 * GET /api/runs/:id/events
 *
 * The one endpoint whose error handling is genuinely awkward, and the awkwardness is stated
 * rather than smoothed over: any non-200 makes `EventSource` stop reconnecting forever (R-13
 * finding 7). So every *pre-flight* failure below is a non-200 on purpose — the client is not yet
 * established and a permanent stop is the honest outcome for a request that can never succeed as
 * written — while every failure *after* the response has begun travels in band as a `run-failed`
 * frame. See `docs/adr/W1-CP-04-resume-cursor-failures.md`.
 *
 * The `outcome` callback below is the other half of that sentence: a run that *itself* failed is
 * also reported in band, as a `run-failed` frame written just before `done`. A stream that ends
 * cleanly is not a run that succeeded — see
 * `docs/adr/W1-CP-04-a-finished-stream-is-not-a-finished-run.md`.
 */
export async function streamRunEvents(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(runId)) {
    return apiError(400, 'invalid_run_id', 'the run id in the path is not a UUID.');
  }

  const cursor = readResumeCursor(
    request.headers.get('last-event-id'),
    new URL(request.url).searchParams.get('after'),
  );
  if (cursor.kind === 'invalid') {
    // NOT a silent restart from the beginning. A client that believes it is resuming and is sent
    // the whole log again renders every event twice and never learns why.
    return apiError(400, 'invalid_resume_cursor', cursor.reason);
  }

  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);
  const scopeMismatch = requireSessionScopeMatch(principal, run.sessionId);
  if (scopeMismatch !== null) return scopeMismatch;
  const permission = requireRunPermission(
    request,
    principal,
    (await env.ownsRun(principal, run)) ? 'own' : 'other',
  );
  if (permission !== null) return permission;

  // A cursor that named a frame *inside* a row is resumed by re-reading that whole row — the store
  // seeks by row and cannot deliver half of one — and dropping the frames the client already has.
  // `id - 1n` is what re-reads it: `after` means "strictly greater than". See `agent-frames.ts`.
  const resumedWithin =
    cursor.kind === 'after' && cursor.subIndex !== null
      ? { sequence: cursor.id, subIndex: cursor.subIndex }
      : null;
  const after =
    cursor.kind !== 'after'
      ? null
      : resumedWithin === null
        ? cursor.id
        : // Row 0 does not exist — sequences start at 1 — so "re-read row 0" is "from the
          // beginning", and saying so keeps a negative id out of the query.
          resumedWithin.sequence === 0n
          ? null
          : cursor.id - 1n;

  const handle = await env.store.openStream(runId, after);
  if (handle === null) {
    return apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);
  }

  const prelude: SseControlFrame[] =
    handle.reset === null ? [] : [{ name: 'stream-reset', data: handle.reset }];

  return sseStreamResponse({
    // ENG-03: the stream serves one vocabulary. A row recorded before it is upgraded here, on read,
    // into the neutral `agent.*` frames — never migrated in place. `agent-frames.ts` says why.
    source: upgradeEventStream(handle.events, resumedWithin),
    prelude,
    signal: request.signal,
    // Re-read the record after the source is exhausted rather than closing over the one fetched
    // above: the run's terminal status is written while the stream is open, so the copy from
    // before the stream started would still say `queued`. `findRunForPrincipal`, not a bare
    // `get`, so an outcome frame can never describe another workspace's run.
    outcome: async (): Promise<StreamOutcome> =>
      classifyRunOutcome(await findRunForPrincipal(env.store, principal, runId), runId),
    onTeardown: () => {
      handle.close();
    },
  });
}
