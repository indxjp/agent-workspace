import { z } from 'zod';

import { EngineIdSchema } from './engines.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';

/**
 * The run lifecycle as the API reports it. `queued` and `running` are live; the other three are
 * terminal, and a terminal run's event stream replays and ends rather than follows.
 */
export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The **model** provider families a model connection can name — who serves the model. Matches
 * `model_connections.provider`.
 *
 * Not the engine. The harness that runs the agent loop is {@link RunResourceSchema}'s `engine`
 * (`EngineId`, `./engines.ts`); this list is who answered the model call it made. One run has both,
 * and they are independent: a `claude-agent-sdk` run can be served by `openai`.
 */
export const MODEL_PROVIDERS = [
  'anthropic',
  'anthropic-compatible',
  'openai',
  'azure-openai',
  'openai-compatible',
] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** How far usage accounting for a run has progressed. `complete` is the only settled answer. */
export const ACCOUNTING_STATES = [
  'pending',
  'complete',
  'partial',
  'failed',
  'unavailable',
] as const;
export type AccountingState = (typeof ACCOUNTING_STATES)[number];

/** The largest prompt one run may carry, in string code units (`docs/adr/W1-CP-04-start-run-request-shape.md`). */
export const MAX_PROMPT_CHARS = 100_000;

export const RunUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    /** Derived by the server: the sum of the four counters above. */
    totalTokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export type RunUsage = z.infer<typeof RunUsageSchema>;

export const RunCostSchema = z
  .object({
    /** A decimal string, never a float — `"0.000000"` until accounting settles. */
    amount: z.string().min(1),
    currency: z.string().min(1),
    priceTableVersion: z.string().nullable(),
  })
  .strict()
  .readonly();

export type RunCost = z.infer<typeof RunCostSchema>;

/**
 * One run as `GET /api/runs/:id`, every item of `GET /api/runs`, and the `202` of
 * `POST /api/agents/:id/runs` render it. Dates are ISO-8601 strings; `durationMs` is `null` until
 * both `startedAt` and `endedAt` exist.
 */
export const RunResourceSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    projectId: z.string().nullable(),
    /** Legacy human attribution; `null` for a run started with an API key. */
    initiatingUserId: z.string().nullable(),
    sessionId: z.string().min(1),
    status: z.enum(RUN_STATUSES),
    createdAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.nullable(),
    endedAt: IsoDateTimeSchema.nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    model: z.string().nullable(),
    /** The **model** provider that served the call, never the engine. See {@link MODEL_PROVIDERS}. */
    provider: z.enum(MODEL_PROVIDERS).nullable(),
    modelConnectionId: z.string().nullable(),
    /**
     * The engine that executed the run. `'claude-agent-sdk'` on every run this release starts, and
     * `null` only for a run recorded before ADR-0065 named the field — the honest answer for a row
     * nobody ever wrote an engine onto, rather than a backfilled guess.
     */
    engine: EngineIdSchema.nullable(),
    /**
     * The adapter's and third-party SDK's version, as the runner reported it. Opaque to the
     * platform: recorded for support, never compared. `null` for a historic run.
     */
    engineVersion: z.string().nullable(),
    usage: RunUsageSchema,
    cost: RunCostSchema,
    /** The safe public failure text, or `null` while the run is live or ended well. */
    error: z.string().nullable(),
    accountingState: z.enum(ACCOUNTING_STATES),
    accountingError: z.string().nullable(),
  })
  .strict()
  .readonly();

export type RunResource = z.infer<typeof RunResourceSchema>;

/**
 * The body of `POST /api/agents/:id/runs`.
 *
 * `modelConnectionId` and `model` override the agent's default for this run only, and travel
 * together or not at all: no layer of the model-resolution ladder may mix a connection from one
 * level with a model from another. `sessionId` continues an existing session; omit it (or send
 * `null`) to start one.
 *
 * `version` runs a new session on that numbered version of the agent instead of the one the `local`
 * pointer names (issue #697). A session keeps the version it started on, so `version` with a
 * `sessionId` is refused. An unknown number is `404 agent_version_not_found`.
 */
export const StartRunRequestSchema = z
  .object({
    prompt: z
      .string()
      .max(MAX_PROMPT_CHARS)
      .refine((prompt) => prompt.trim().length > 0, { message: 'prompt must not be empty' }),
    sessionId: UuidSchema.nullable().optional(),
    modelConnectionId: UuidSchema.nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    // The number range of `AgentVersionResource.number`; not imported, because agent-versions
    // reaches this file through surfaces.
    version: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict()
  .refine((body) => body.version === undefined || (body.sessionId ?? null) === null, {
    message: 'version applies to a new session: omit sessionId',
    path: ['version'],
  })
  .refine(
    (body) => {
      const hasConnection = (body.modelConnectionId ?? null) !== null;
      const hasModel = (body.model ?? null) !== null;
      return hasConnection === hasModel;
    },
    { message: 'modelConnectionId and model must be supplied together, or not at all' },
  )
  .readonly();

export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

/** The `202` body of `POST /api/agents/:id/runs`: the queued run and where to stream it from. */
export const StartRunResponseSchema = z
  .object({
    run: RunResourceSchema,
    /** Relative to the API origin: `/api/runs/:id/events`. Also sent as the `Location` header. */
    events: z.string().min(1),
  })
  .strict()
  .readonly();

export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

/**
 * Why `POST /api/agents/:id/runs` refused to queue a run (issue #393), with the status each one
 * travels under. Every one is decided **before** a run row exists, so a refused start leaves no
 * queued run behind, and each names the one missing piece an operator fixes:
 *
 * - `agent_runtime_profile_missing` — the agent has no runtime profile, or the one it names no
 *   longer exists. Attach a runtime profile to the agent.
 * - `model_connection_unresolved` — no layer of the model-resolution ladder (run override, agent,
 *   project, workspace default, then the deployment default model) names a usable connection: none
 *   is configured, the named one was deleted, it is not ready, or its credential cannot be read.
 *   The deployment default applies when the agent names a connection without a model; it is
 *   refused with this code too when the deployment sets no model for that connection's provider.
 * - `model_connection_failed` — the connection's provider could not be connected to at all: the
 *   connection was refused or its name did not resolve (issue #661). The key is not the problem;
 *   check the connection's base URL and this host's network (proxy, DNS).
 * - `model_unavailable` — the connection is usable and its model list was read, and the selected
 *   model is not on it. A run queued while the list could not be read, whose model the provider
 *   then refuses as unknown, fails with this code too.
 * - `model_credential_rejected` — the provider answered the model list with `401`/`403`: the
 *   connection's API key was rejected. Replace the key. A run whose provider rejects the key only
 *   once it is running fails at once with this code too, instead of retrying (issue #661).
 *
 * A model list that cannot be read for a reason that may pass (a `429`, a `5xx`, a timeout or a
 * reset) is not a refusal: every selection is an explicit model on a ready connection, so the
 * server logs a warning and lets the run proceed. There is therefore no "discovery failed" code.
 *
 * - `policy_cannot_widen` — the run asks for more than the deployment's policy ceiling allows: an
 *   engine or a model outside its allowlist, judged at the start for an explicit `modelOverride`
 *   and in preflight for the resolved model (ADR-0102 SD6, C14, issue #524).
 * - `network_policy_unenforceable` — the agent lacks `unrestrictedNetwork`, so its `open` profile
 *   was lowered to `restricted` for its remote connectors' hosts, and the profile's driver cannot
 *   enforce `restricted` (ADR-0117 decisions 7 and 9, issue #785). Grant `unrestrictedNetwork`,
 *   remove the remote connectors, or pick a driver that enforces `restricted`. It is judged when
 *   the run launches, so the run fails with this code rather than the start answering it.
 * - `run_deadline_exceeds_host` — the runtime profile's `timeoutSeconds` is longer than the longest
 *   run the control plane's host allows (on Vercel Functions, the function's maximum duration;
 *   ADR-0120 LC7, issue #830). Shorten the profile's deadline. It is judged when the run launches,
 *   so the run fails with this code before the runtime is contacted.
 * - `runtime_connection_missing` — the runtime profile's driver is a provider sandbox (`external`,
 *   `vercel-sandbox`, `cloudflare-sandbox`) and its runtime connection is absent: the profile names
 *   none, or the named one was deleted or belongs to another workspace or driver (ADR-0120 LC6).
 *   Attach a runtime connection of that driver to the profile. It is judged when the run launches,
 *   so the run fails with this code before the runtime is contacted.
 * - `runtime_connection_credential_unavailable` — the runtime connection exists but holds no
 *   usable provider credential. Replace the credential on the connection. Judged at launch too.
 * - `runtime_not_verified` — the profile's driver has no current Test Runtime pass: it never
 *   passed, or its pass lapsed (it lasts 24 hours, and a new runtime image needs a new one) and
 *   re-verifying it automatically failed. Run Test Runtime, then retry. Judged at launch too.
 *
 * The ten configuration codes are `422`: the request is well formed and the agent exists — it is
 * the workspace's configuration that cannot run it yet. The ceiling refusal is `403`: it refuses
 * what is asked rather than naming a missing piece (C14).
 */
export const RUN_START_PROBLEM_CODES = {
  agent_runtime_profile_missing: 422,
  model_connection_unresolved: 422,
  model_connection_failed: 422,
  model_unavailable: 422,
  model_credential_rejected: 422,
  network_policy_unenforceable: 422,
  run_deadline_exceeds_host: 422,
  runtime_connection_missing: 422,
  runtime_connection_credential_unavailable: 422,
  runtime_not_verified: 422,
  /**
   * The run would exceed the policy ceiling (C14, ADR-0102 SD6, issue #524). `details` are the
   * `policyWidenings` of the run's configuration, in C14 order. It is answered whatever the
   * caller's role.
   */
  policy_cannot_widen: 403,
} as const;

export type RunStartProblemCode = keyof typeof RUN_START_PROBLEM_CODES;

const RUN_START_PROBLEM_CODE_SET: ReadonlySet<string> = new Set(
  Object.keys(RUN_START_PROBLEM_CODES),
);

export function isRunStartProblemCode(value: string): value is RunStartProblemCode {
  return RUN_START_PROBLEM_CODE_SET.has(value);
}

/**
 * The run-failure code of a run whose runtime refused it for capacity (issue #557).
 *
 * Not a start refusal, and so not in {@link RUN_START_PROBLEM_CODES}: `POST /api/agents/:id/runs`
 * has already answered `202` when the runtime says it is serving its maximum number of concurrent
 * runs. The server waits for a free slot for a bounded time; only a runtime that stays full for
 * that whole wait fails the run, with a stored `error` of the form
 * `runtime_capacity_exhausted: <message>`. Nothing ran, so the failure is retryable: a client may
 * offer to send the message again.
 */
export const RUNTIME_CAPACITY_EXHAUSTED = 'runtime_capacity_exhausted' as const;

/**
 * The run-failure code of a run whose request could not be prepared (issue #827): something threw
 * while the control plane resolved the runtime, allocated it or composed the run request. The
 * stored `error` is `run_preparation_failed: The run request could not be prepared at the <step>
 * step (<ErrorName>[: <safe cause>[: <manager message>]]).` — the step is one of a closed set.
 * Nothing from the failure's own message is repeated, except that a runner manager's
 * `tool_sandbox_unavailable` answer appends its message, redacted of the run's secret values, URLs
 * and long tokens, capped at 400 characters, and withheld when the run's secrets are unknown. Not
 * retryable as is.
 */
export const RUN_PREPARATION_FAILED = 'run_preparation_failed' as const;

/**
 * A run's stored `error`, split into its safe code and its message.
 *
 * A run that is refused only once it is being composed — a race with an edit made after the start
 * was accepted, or a deployment whose run API performs no pre-queue check — records an `error` of
 * the form `<code>: <message>`, the same shape `engine_model_protocol_unsupported` already uses.
 * A run whose runtime stayed at its concurrent-run capacity for the launcher's whole wait budget
 * records {@link RUNTIME_CAPACITY_EXHAUSTED} the same way (issue #557); that one is retryable.
 * This reads the code back so a client can branch on it rather than on prose. `code` is `null`
 * for an error that carries no recognised code (a runtime failure, an older run).
 */
export interface RunFailure {
  readonly code:
    | RunStartProblemCode
    | 'engine_model_protocol_unsupported'
    | typeof RUNTIME_CAPACITY_EXHAUSTED
    | typeof RUN_PREPARATION_FAILED
    | null;
  readonly message: string;
}

const CODED_ERROR = /^([a-z][a-z0-9_]*): ([\s\S]*)$/u;

export function parseRunFailure(error: string | null): RunFailure | null {
  if (error === null) return null;
  const match = CODED_ERROR.exec(error);
  const code = match?.[1];
  const message = match?.[2];
  if (code === undefined || message === undefined) return { code: null, message: error };
  if (
    code === 'engine_model_protocol_unsupported' ||
    code === RUNTIME_CAPACITY_EXHAUSTED ||
    code === RUN_PREPARATION_FAILED ||
    isRunStartProblemCode(code)
  ) {
    return { code, message };
  }
  return { code: null, message: error };
}

/** The body of `GET /api/runs/:id`. */
export const RunResponseSchema = z.object({ run: RunResourceSchema }).strict().readonly();

/**
 * The body of `POST /api/runs/:id/interrupt` (issue #235, S-14): the run, re-read after its
 * terminal status is written, so a caller learns the status it actually reached rather than the
 * one it asked for.
 */
export const InterruptRunResponseSchema = z.object({ run: RunResourceSchema }).strict().readonly();

export type InterruptRunResponse = z.infer<typeof InterruptRunResponseSchema>;

/**
 * The body of `POST /api/runs/:id/revoke-tokens` (issue #235, S-15) and, until the next major release (ADR-0078 D7), the
 * deprecated `POST /api/runs/:id`: `revoked` is how many gateway tokens the call actually revoked,
 * and `outcome` is the repository's own vocabulary — a single-token request answers `revoked`,
 * `already-revoked` or `not-found`; an all-tokens request answers `revoked` or
 * `already-revoked`, or `not-found` if the caller's workspace scope cannot be resolved.
 */
export const RevokeRunTokensResponseSchema = z
  .object({
    revoked: z.number().int().nonnegative(),
    outcome: z.enum(['revoked', 'already-revoked', 'not-found']),
  })
  .strict()
  .readonly();

export type RevokeRunTokensResponse = z.infer<typeof RevokeRunTokensResponseSchema>;

/** The default and largest page `GET /api/runs` serves. */
export const RUN_LIST_DEFAULT_LIMIT = 20;
export const RUN_LIST_MAX_LIMIT = 200;

/** The body of `GET /api/runs`: one page, newest first, and an opaque cursor for the next one. */
export const RunListResponseSchema = z
  .object({
    runs: z.array(RunResourceSchema).readonly(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();

export type RunListResponse = z.infer<typeof RunListResponseSchema>;

/**
 * The filters `GET /api/runs` accepts. Every field is optional; `user` is honoured only for a
 * caller whose grant covers the whole workspace (Owner or Admin) and is otherwise a `403`
 * `user_filter_forbidden`. `from`/`to` are ISO-8601 instants; `cursor` is exactly the
 * `nextCursor` of a previous page.
 */
export interface RunListQuery {
  readonly status?: RunStatus;
  readonly agent?: string;
  readonly project?: string;
  readonly provider?: ModelProvider;
  readonly model?: string;
  readonly from?: string;
  readonly to?: string;
  readonly user?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Render a {@link RunListQuery} as the query string the route parses, omitting absent fields. */
export function runListSearchParams(query: RunListQuery): URLSearchParams {
  const params = new URLSearchParams();
  const entries: readonly (readonly [string, string | number | undefined])[] = [
    ['status', query.status],
    ['agent', query.agent],
    ['project', query.project],
    ['provider', query.provider],
    ['model', query.model],
    ['from', query.from],
    ['to', query.to],
    ['user', query.user],
    ['limit', query.limit],
    ['cursor', query.cursor],
  ];
  for (const [name, value] of entries) {
    if (value !== undefined) params.set(name, String(value));
  }
  return params;
}
