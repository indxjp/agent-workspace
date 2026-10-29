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
import { createHash } from 'node:crypto';

import {
  AGENT_VERSION_NUMBER_MAX,
  AGENT_VERSION_PROBLEM_CODES,
} from '@indx-workspace/contracts/agent-versions';
import { IDENTITY_SUBJECT_MAX_LENGTH } from '@indx-workspace/contracts/identity-assertion';
import {
  isCanonicalFileScopePath,
  MAX_RUN_ATTACHMENTS,
  MAX_RUN_FILE_SCOPE_PATHS,
  outputSchemaViolation,
  RUN_IDEMPOTENCY_PROBLEM_CODES,
  RUN_START_PROBLEM_CODES,
} from '@indx-workspace/contracts/runs';
import { SURFACE_LIMIT_PROBLEM_CODES } from '@indx-workspace/contracts/surfaces';

import { forVisitor, upgradeEventStream } from './agent-frames';
import { resolveRunAttachments } from './attachments';
import { readResumeCursor } from './cursor';
import {
  getRunApi,
  RUN_API_NOT_CONFIGURED_MESSAGE,
  type AgentRef,
  type RunPrincipal,
  type RunApiEnvironment,
} from './environment';
import { featureRefusalResponse } from '../features/guard';
import { apiError, isUuid, json, readJsonBody } from './http';
import { encodeRunListCursor, parseRunListQuery } from './list-query';
import { MAX_PROMPT_CHARS, startRunOnSession, type StartRunBody } from './service';
import { sseStreamResponse, type SseControlFrame, type StreamOutcome } from './sse';
import {
  IdempotencyKeyTakenError,
  isTerminalRunStatus,
  type RunIdempotency,
  type RunRecord,
  type RunStore,
} from './store';
import { decide, type Ownership } from '../rbac/decide';
import type { Grant } from '../rbac/permissions';
import { parseRole } from '../rbac/roles';
import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { publishedEngineId } from '../engines/session-engine';
import { enforceCeiling } from '../policy-ceiling/ceiling';

export type StartRunBodyVerdict =
  | { readonly kind: 'ok'; readonly body: StartRunBody }
  | { readonly kind: 'rejected'; readonly reason: string };

const START_RUN_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'sessionId',
  'modelConnectionId',
  'model',
  'version',
  'attachments',
  'outputSchema',
  'subject',
  'fileScope',
]);

type AttachmentsParse =
  | { readonly kind: 'ok'; readonly attachments: StartRunBody['attachments'] }
  | { readonly kind: 'rejected'; readonly reason: string };

/** The same rules as `StartRunRequestSchema.attachments`: 1 to 10 strict `{ fileId }`, no repeats. */
function parseAttachments(raw: unknown): AttachmentsParse {
  if (raw === undefined) return { kind: 'ok', attachments: undefined };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RUN_ATTACHMENTS) {
    return {
      kind: 'rejected',
      reason: `"attachments" must be an array of 1 to ${String(MAX_RUN_ATTACHMENTS)} items when it is present`,
    };
  }
  const seen = new Set<string>();
  const attachments: { readonly fileId: string }[] = [];
  for (const item of raw as unknown[]) {
    const fileId =
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? (item as Record<string, unknown>)['fileId']
        : undefined;
    if (
      typeof fileId !== 'string' ||
      fileId.length === 0 ||
      Object.keys(item as object).length !== 1
    ) {
      return {
        kind: 'rejected',
        reason: 'each "attachments" item must be an object with only a non-empty "fileId"',
      };
    }
    if (seen.has(fileId)) {
      return { kind: 'rejected', reason: '"attachments" must not name the same "fileId" twice' };
    }
    seen.add(fileId);
    attachments.push({ fileId });
  }
  return { kind: 'ok', attachments };
}

function parseOutputSchema(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly schema: Readonly<Record<string, unknown>> | undefined }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (raw === undefined) return { kind: 'ok', schema: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'rejected', reason: '"outputSchema" must be a JSON Schema object' };
  }
  const violation = outputSchemaViolation(raw);
  if (violation !== null) {
    return { kind: 'rejected', reason: `"outputSchema" is not accepted: ${violation.message}` };
  }
  return { kind: 'ok', schema: raw as Readonly<Record<string, unknown>> };
}

function parseSubject(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly field: { readonly subject?: string } }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (raw === undefined) return { kind: 'ok', field: {} };
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= IDENTITY_SUBJECT_MAX_LENGTH) {
    return { kind: 'ok', field: { subject: raw } };
  }
  return {
    kind: 'rejected',
    reason: `"subject" must be a string of 1 to ${String(IDENTITY_SUBJECT_MAX_LENGTH)} characters when it is present`,
  };
}

/** The same rules as `StartRunRequestSchema.fileScope`: 1 to 100 canonical paths, no repeats. */
function parseFileScope(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly field: { readonly fileScope?: readonly string[] } }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (raw === undefined) return { kind: 'ok', field: {} };
  if (
    Array.isArray(raw) &&
    raw.length >= 1 &&
    raw.length <= MAX_RUN_FILE_SCOPE_PATHS &&
    (raw as unknown[]).every(
      (path) => typeof path === 'string' && isCanonicalFileScopePath(path),
    ) &&
    new Set(raw as string[]).size === raw.length
  ) {
    return { kind: 'ok', field: { fileScope: raw as string[] } };
  }
  return {
    kind: 'rejected',
    reason: `"fileScope" must be an array of 1 to ${String(MAX_RUN_FILE_SCOPE_PATHS)} distinct canonical workspace-relative paths when it is present`,
  };
}

/** The start-run keys this server refuses, or `null` when every key is one it honours. */
function refuseStartRunKeys(record: Record<string, unknown>): StartRunBodyVerdict | null {
  const unknown = Object.keys(record).find((key) => !START_RUN_KEYS.has(key));
  return unknown === undefined
    ? null
    : { kind: 'rejected', reason: `unknown field ${JSON.stringify(unknown)} in the request body` };
}

/**
 * Parse the start-run body. **Never throws**, and never returns `ok` for a shape it did not
 * positively recognise — an unknown key is rejected rather than ignored, for the reason
 * `packages/run-protocol/src/schemas.ts` already gives about `.strict()`: a setting the server does not
 * know how to honour, accepted silently, is a request the caller believes was obeyed.
 */
export function parseStartRunBody(input: unknown): StartRunBodyVerdict {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { kind: 'rejected', reason: 'the request body must be a JSON object' };
  }
  const record = input as Record<string, unknown>;
  const keyRefusal = refuseStartRunKeys(record);
  if (keyRefusal !== null) return keyRefusal;
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
  const options = parseRunOptions(record);
  if (options.kind === 'rejected') return options;
  const { version, ...perRun } = options.fields;
  const rawSession = record['sessionId'];
  if (rawSession === undefined || rawSession === null) {
    return { kind: 'ok', body: { prompt, sessionId: null, modelOverride, ...options.fields } };
  }
  if (!isUuid(rawSession)) {
    return { kind: 'rejected', reason: '"sessionId" must be a UUID when it is present' };
  }
  if (version !== undefined) {
    return {
      kind: 'rejected',
      reason: '"version" applies to a new session: omit "sessionId"',
    };
  }
  return { kind: 'ok', body: { prompt, sessionId: rawSession, modelOverride, ...perRun } };
}

/** The optional `version`, `outputSchema`, `attachments`, `subject` and `fileScope` of a start-run body, each checked. */
function parseRunOptions(record: Record<string, unknown>):
  | {
      readonly kind: 'ok';
      readonly fields: Pick<
        StartRunBody,
        'version' | 'outputSchema' | 'attachments' | 'subject' | 'fileScope'
      >;
    }
  | { readonly kind: 'rejected'; readonly reason: string } {
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
  const attached = parseAttachments(record['attachments']);
  if (attached.kind === 'rejected') return attached;
  const parsedSchema = parseOutputSchema(record['outputSchema']);
  if (parsedSchema.kind === 'rejected') return parsedSchema;
  const parsedSubject = parseSubject(record['subject']);
  if (parsedSubject.kind === 'rejected') return parsedSubject;
  const parsedScope = parseFileScope(record['fileScope']);
  if (parsedScope.kind === 'rejected') return parsedScope;
  return {
    kind: 'ok',
    fields: {
      ...(rawVersion === undefined ? {} : { version: rawVersion }),
      ...(parsedSchema.schema === undefined ? {} : { outputSchema: parsedSchema.schema }),
      ...(attached.attachments === undefined ? {} : { attachments: attached.attachments }),
      ...parsedSubject.field,
      ...parsedScope.field,
    },
  };
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
    // #612, ADR-0101: the version the session pins; `null` for a legacy unversioned session.
    agentVersion: run.agentVersion ?? null,
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
    // ADR-0143: `null` until the run is `completed`, and for a failed or cancelled one.
    output: run.output ?? null,
    // ADR-0145: the call being waited on, only while the run is paused; `approvedToolCalls` is a
    // continuation's private input and is never rendered.
    pendingApproval: run.status === 'awaiting_approval' ? (run.pendingApproval ?? null) : null,
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
  principal: RunPrincipal,
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
  principal: RunPrincipal,
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
  principal: RunPrincipal,
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
  principal: RunPrincipal,
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

/** The longest `Idempotency-Key` a run start accepts; the trigger firing's bound. */
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;

/** A start's answer: `202` with the run and its stream URL, for a new run and a replay alike. */
function accepted(run: RunRecord): Response {
  // 202, not 201: the run is accepted and queued, and what the caller actually wants is the
  // stream, whose URL is in the body and in Location.
  const events = `/api/runs/${run.id}/events`;
  return json({ run: renderRun(run), events }, 202, { Location: events });
}

/**
 * The start key of this request (ADR-0151, #250): `undefined` when absent, `invalid`, or the key with the acting
 * principal and the SHA-256 of what was asked: the parsed body's JSON with every object's members
 * sorted, so a retry that lists the same members in another order (an `outputSchema` rebuilt by
 * the client) is the same request. Arrays keep their order; it is part of what was asked.
 */
function readIdempotencyKey(
  request: Request,
  principal: RunPrincipal,
  agentId: string,
  body: StartRunBody,
): RunIdempotency | 'invalid' | undefined {
  const header = request.headers.get('idempotency-key');
  if (header === null) return undefined;
  const key = header.trim();
  if (key === '' || key.length > MAX_IDEMPOTENCY_KEY_CHARS) return 'invalid';
  const canonical = JSON.stringify({ agentId, body }, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)))
      : value,
  );
  const requestHash = createHash('sha256').update(canonical).digest('hex');
  return { principalId: principal.principalId, key, requestHash };
}

/**
 * The answer to a start whose key is already held: the original run whatever its status — a
 * paused run never frees its key — or `409 run_idempotency_conflict` for a different request.
 * `null` when the key is not held.
 */
async function replayStart(
  store: RunStore,
  principal: RunPrincipal,
  idempotency: RunIdempotency,
): Promise<Response | null> {
  const held = await store.findByIdempotencyKey(
    principal.workspaceId,
    idempotency.principalId,
    idempotency.key,
  );
  if (held === null) return null;
  if (held.requestHash !== idempotency.requestHash) {
    return apiError(
      RUN_IDEMPOTENCY_PROBLEM_CODES.run_idempotency_conflict,
      'run_idempotency_conflict',
      'this Idempotency-Key was already used with a different request; send a new key.',
    );
  }
  return accepted(held.run);
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
  // ADR-0142 D2: only a backend acting for its own users names a subject. A session or a browser
  // token states who it is already, so it cannot assert someone else.
  if (parsed.body.subject !== undefined && principal.via !== 'api-key') {
    return apiError(
      RUN_START_PROBLEM_CODES.run_subject_forbidden,
      'run_subject_forbidden',
      '"subject" may only be set by an API key; remove it from the request.',
    );
  }
  // §3.1's session scope: "start runs in that session", never a new one and never another. A body
  // that omits `sessionId` is refused the same way a body naming a different session is, rather
  // than silently starting a fresh session the token was never scoped to.
  const scopeMismatch = requireSessionScopeMatch(principal, parsed.body.sessionId);
  if (scopeMismatch !== null) return scopeMismatch;
  // ADR-0151: a replay is answered before anything a fresh start would do — no visitor turn, no
  // preflight, no session — so it returns the original run even when a new start would be refused.
  const idempotency = readIdempotencyKey(request, principal, agentId, parsed.body);
  if (idempotency === 'invalid') {
    return apiError(
      RUN_IDEMPOTENCY_PROBLEM_CODES.invalid_idempotency_key,
      'invalid_idempotency_key',
      `Idempotency-Key must be 1 to ${String(MAX_IDEMPOTENCY_KEY_CHARS)} characters.`,
    );
  }
  if (idempotency !== undefined) {
    const replay = await replayStart(env.store, principal, idempotency);
    if (replay !== null) return replay;
  }
  const overLimit = await refuseOverVisitorLimit(env, principal, 'turn', request.headers);
  if (overLimit !== null) return overLimit;

  // A follow-up's agent carries its conversation's pinned engine (issue #612), which the model
  // override's ceiling check below and the engine pin in `startRunOnSession` (`service.ts`) read.
  const agent = await env.findAgent(principal, agentId, parsed.body.sessionId);
  // 404 rather than 403 when the agent belongs to another workspace: §25's isolation rule is not
  // satisfied by a status code that confirms the row exists.
  if (agent === null) {
    return apiError(404, 'agent_not_found', `no agent ${agentId} in this workspace.`);
  }

  const attachments =
    parsed.body.attachments === undefined
      ? ({ kind: 'ok', files: [] } as const)
      : await resolveRunAttachments(principal, parsed.body.attachments, parsed.body.sessionId);
  if (attachments.kind === 'refused') return attachments.response;

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

  let started: Awaited<ReturnType<typeof startRunOnSession>>;
  try {
    started = await startRunOnSession(env, principal, agent, {
      ...parsed.body,
      attachments: attachments.files,
      ...(agentVersionId === undefined ? {} : { agentVersionId }),
      ...(idempotency === undefined ? {} : { idempotency }),
    });
  } catch (error) {
    // Two starts with one key raced and the other committed first: answer with its run.
    if (!(error instanceof IdempotencyKeyTakenError) || idempotency === undefined) throw error;
    const replay = await replayStart(env.store, principal, idempotency);
    if (replay === null) throw error;
    return replay;
  }
  if (started.kind === 'refused') {
    return apiError(started.status, started.code, started.message, started.details);
  }
  return accepted(started.run);
}

/**
 * Look a run up and confirm it belongs to this principal's workspace.
 *
 * Returns `null` for "no such run" and for "not yours" alike, and both become a 404. §25's
 * isolation is not satisfied by a status code that tells a caller the row exists.
 */
export async function findRunForPrincipal(
  store: RunStore,
  principal: RunPrincipal,
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
function decideRunListAccess(request: Request, principal: RunPrincipal): RunListAccess {
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

/**
 * GET /api/runs — a workspace-scoped, filtered, cursor-paginated run list (issue #135). Every
 * item is rendered by the exact {@link renderRun} `readRun` uses, so list and detail cannot drift.
 */
export async function listRuns(request: Request): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  const disabled = await featureRefusalResponse(request, principal.workspaceId);
  if (disabled !== null) return disabled;

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
  principal: RunPrincipal,
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
    case 'awaiting_approval':
      return { kind: 'paused' };
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
    // ADR-0145 D4: a session-scoped token is a visitor, and is never served operator-only fields.
    source:
      principal.scope?.kind === 'session'
        ? forVisitor(upgradeEventStream(handle.events, resumedWithin))
        : upgradeEventStream(handle.events, resumedWithin),
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
