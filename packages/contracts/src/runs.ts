import { z } from 'zod';

import { EngineIdSchema } from './engines.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { IDENTITY_SUBJECT_MAX_LENGTH } from './identity-assertion.js';

/**
 * The run lifecycle as the API reports it. `queued` and `running` are live. `awaiting_approval`
 * is a pause: the run stopped before a tool call its agent requires approval for (ADR-0145) and
 * is not live, yet not final either — a decision starts a continuation run and completes it, an
 * interrupt cancels it. The other three are terminal, and a terminal run's event stream replays
 * and ends rather than follows.
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The statuses in which nothing is executing: the terminal ones and the `awaiting_approval` pause.
 * An event stream and `runs.result()` end at one of these; a run interrupt still refuses only a
 * terminal run, because a paused run can be cancelled.
 */
export const STOPPED_RUN_STATUSES = [...TERMINAL_RUN_STATUSES, 'awaiting_approval'] as const;
const STOPPED: ReadonlySet<string> = new Set(STOPPED_RUN_STATUSES);

export function isStoppedRunStatus(status: RunStatus): boolean {
  return STOPPED.has(status);
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

/** The most workspace files one run may carry as attachments (ADR-0146 Decision 5). */
export const MAX_RUN_ATTACHMENTS = 10;

/** The most paths one run's `fileScope` may name (issue #1539). */
export const MAX_RUN_FILE_SCOPE_PATHS = 100;

/** The longest one `fileScope` path, in characters. */
const MAX_RUN_FILE_SCOPE_PATH_LENGTH = 1024;

/**
 * A canonical workspace-relative path: no leading or trailing `/`, no empty, `.` or `..` segment,
 * no backslash and no NUL. A path that is not canonical can never name a granted file.
 */
export function isCanonicalFileScopePath(path: string): boolean {
  if (path.length < 1 || path.length > MAX_RUN_FILE_SCOPE_PATH_LENGTH) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

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
 * What a completed run answered (ADR-0143): the final assistant text, and the value that satisfies
 * the request's `outputSchema` (`null` when the request carried none).
 */
export const RunOutputSchema = z
  .object({
    text: z.string(),
    structured: z.unknown(),
  })
  .strict()
  .readonly();

export type RunOutput = z.infer<typeof RunOutputSchema>;

/**
 * The tool call a paused run is waiting for a decision on (ADR-0145): the tool's name and the
 * canonical form of the call, which is exactly what an approval lets the continuation run.
 */
export const RunApprovalCallSchema = z
  .object({
    toolName: z.string().min(1),
    canonicalCall: z.string().min(1),
  })
  .strict()
  .readonly();

export type RunApprovalCall = z.infer<typeof RunApprovalCallSchema>;

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
    /**
     * The number of the agent version this run's session pins (#612, ADR-0101): the version the run
     * executed, whose definition names the skill revisions it applied. `null` for a legacy session
     * created before versions existed. Server-set and read-only.
     */
    agentVersion: z.number().int().min(1).nullable(),
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
    /** The answer once the run is `completed`; `null` while it is live and for a failed or cancelled run. */
    output: RunOutputSchema.nullable(),
    /**
     * The call the run is waiting for a decision on while `status` is `awaiting_approval`, and
     * `null` in every other status (once decided, the continuation run carries the approved call).
     */
    pendingApproval: RunApprovalCallSchema.nullable(),
    accountingState: z.enum(ACCOUNTING_STATES),
    accountingError: z.string().nullable(),
  })
  .strict()
  .readonly();

export type RunResource = z.infer<typeof RunResourceSchema>;

/** The largest `outputSchema` a request may carry: its JSON serialisation in UTF-8 bytes (ADR-0143). */
export const OUTPUT_SCHEMA_MAX_BYTES = 32_768;
/** The deepest nesting of schema objects an `outputSchema` may have; the root is level 1. */
export const OUTPUT_SCHEMA_MAX_DEPTH = 16;
/** The one JSON Schema dialect an `outputSchema` may declare. */
export const OUTPUT_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** The limits an `outputSchema` can break; each failure message begins with its name. */
export const OUTPUT_SCHEMA_LIMITS = ['root_type', 'size', 'dialect', 'ref', 'depth'] as const;
export type OutputSchemaLimit = (typeof OUTPUT_SCHEMA_LIMITS)[number];

export interface OutputSchemaViolation {
  readonly limit: OutputSchemaLimit;
  /** `<limit>: <what failed>`, safe to show a caller; it never repeats the schema. */
  readonly message: string;
}

const LOCAL_DEFS_REF = /^#\/\$defs\/([^/]+)$/u;

// The keywords whose value is a schema, a list of schemas or a map of schemas.
const SCHEMA_KEYWORDS = [
  'items',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
] as const;
const SCHEMA_LIST_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;
const SCHEMA_MAP_KEYWORDS = [
  'properties',
  '$defs',
  'patternProperties',
  'dependentSchemas',
] as const;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function violation(limit: OutputSchemaLimit, detail: string): OutputSchemaViolation {
  return { limit, message: `${limit}: ${detail}` };
}

function subschemas(schema: Readonly<Record<string, unknown>>): readonly unknown[] {
  const found: unknown[] = [];
  for (const keyword of SCHEMA_KEYWORDS) found.push(schema[keyword]);
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    const list = schema[keyword];
    if (Array.isArray(list)) found.push(...(list as readonly unknown[]));
  }
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword];
    if (isPlainObject(map)) found.push(...Object.values(map));
  }
  return found;
}

interface OutputSchemaWalk {
  readonly defs: Readonly<Record<string, unknown>>;
  /** The definitions being followed on the current path, to refuse a recursive `$ref`. */
  readonly following: Set<string>;
  /** `<name>@<level>` of definitions already walked within every limit, so a shared one costs once. */
  readonly passed: Set<string>;
}

function walkOutputSchema(
  schema: unknown,
  level: number,
  walk: OutputSchemaWalk,
): OutputSchemaViolation | null {
  if (!isPlainObject(schema)) return null;
  if (level > OUTPUT_SCHEMA_MAX_DEPTH) {
    return violation('depth', `schemas nest more than ${OUTPUT_SCHEMA_MAX_DEPTH} levels deep`);
  }
  if ('$dynamicRef' in schema) return violation('ref', '$dynamicRef is not supported');
  const ref = schema['$ref'];
  if (ref !== undefined) {
    const name = typeof ref === 'string' ? LOCAL_DEFS_REF.exec(ref)?.[1] : undefined;
    const key = name?.replaceAll('~1', '/').replaceAll('~0', '~');
    if (key === undefined || !Object.hasOwn(walk.defs, key)) {
      return violation('ref', '$ref must be "#/$defs/<name>" and name a definition in the schema');
    }
    if (walk.following.has(key)) {
      return violation('ref', '$ref must not be recursive: a definition reaches itself');
    }
    // The referenced definition stands in place of this schema, so it is measured at this level.
    const visit = `${key}@${level}`;
    if (!walk.passed.has(visit)) {
      walk.following.add(key);
      const found = walkOutputSchema(walk.defs[key], level, walk);
      walk.following.delete(key);
      if (found !== null) return found;
      walk.passed.add(visit);
    }
  }
  for (const child of subschemas(schema)) {
    const found = walkOutputSchema(child, level + 1, walk);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Judge an `outputSchema` against the limits of ADR-0143, structurally and without a JSON Schema
 * library: root `type: "object"`, at most {@link OUTPUT_SCHEMA_MAX_BYTES} bytes, draft 2020-12, only
 * local, non-recursive `#/$defs/<name>` references, at most {@link OUTPUT_SCHEMA_MAX_DEPTH} nested
 * levels with each reference followed. `null`
 * means the schema is within every limit. This is the one owner of the rule: the request schema and
 * the server's body parser both call it.
 */
export function outputSchemaViolation(schema: unknown): OutputSchemaViolation | null {
  if (!isPlainObject(schema) || schema['type'] !== 'object') {
    return violation('root_type', 'the root of outputSchema must be a schema with type "object"');
  }
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(schema);
  } catch {
    serialised = undefined;
  }
  if (
    serialised === undefined ||
    new TextEncoder().encode(serialised).length > OUTPUT_SCHEMA_MAX_BYTES
  ) {
    return violation(
      'size',
      `outputSchema must be JSON of at most ${OUTPUT_SCHEMA_MAX_BYTES} bytes`,
    );
  }
  const dialect = schema['$schema'];
  if (dialect !== undefined && dialect !== OUTPUT_SCHEMA_DIALECT) {
    return violation(
      'dialect',
      `$schema must be ${OUTPUT_SCHEMA_DIALECT} (JSON Schema draft 2020-12)`,
    );
  }
  const defs = isPlainObject(schema['$defs']) ? schema['$defs'] : {};
  return walkOutputSchema(schema, 1, { defs, following: new Set(), passed: new Set() });
}

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
 *
 * `attachments` names workspace files (`FileResource.id`) the run may read, one to
 * {@link MAX_RUN_ATTACHMENTS}, each at most once (ADR-0146, issue #1307). Each is granted to this
 * run as `read` and named in the user turn. An id the caller cannot read, or that does not exist,
 * is the same concealed `404 file_not_found`; an agent without `readFiles` is
 * `422 run_attachments_unreadable`; a file over `SURFACE_ATTACHMENT_MAX_BYTES` (10 MiB), or a
 * session whose attachments, the ones it stored earlier included, pass
 * `SURFACE_ATTACHMENTS_MAX_FILES` (20) or `SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES` (50 MiB) together,
 * are `422 run_attachments_too_large`; a run on the `local` runtime driver is `422 run_attachments_unsupported_runtime`. A session-scoped
 * browser token may attach only files uploaded to its own session by
 * `POST /api/sessions/:id/attachments` (issue #1308); any other id is the same concealed `404`.
 *
 * `fileScope` narrows the files the run can search and read to a subset of what the agent is
 * granted (ADR-0147, issue #1539): one to {@link MAX_RUN_FILE_SCOPE_PATHS} canonical
 * workspace-relative paths, each a granted file or a folder inside a grant, each at most once. The
 * calling app, which knows the subject, scopes built-in `search_files` per caller with it. It never
 * widens: a path outside the agent's effective grants fails the run with
 * `403 run_file_scope_not_granted`, judged when the run launches. Absent, the run keeps all of the
 * agent's grants.
 *
 * `outputSchema` asks for the answer as a value of that JSON Schema (ADR-0143): it comes back as
 * `RunResource.output.structured`. It must satisfy {@link outputSchemaViolation}, and an engine
 * that cannot honour it is refused with `422 engine_capability_unsupported`.
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
    attachments: z
      .array(z.object({ fileId: z.string().min(1) }).strict())
      .min(1)
      .max(MAX_RUN_ATTACHMENTS)
      .refine((items) => new Set(items.map((item) => item.fileId)).size === items.length, {
        message: 'attachments must not repeat a fileId',
      })
      .optional(),
    /**
     * The person an API-key caller acts for: opaque, 1 to 256 characters (ADR-0142 D2). It becomes
     * the `sub` of the identity assertion. Any other caller is refused `403 run_subject_forbidden`.
     */
    subject: z.string().min(1).max(IDENTITY_SUBJECT_MAX_LENGTH).optional(),
    fileScope: z
      .array(
        z.string().refine(isCanonicalFileScopePath, {
          message: 'fileScope paths must be canonical workspace-relative paths',
        }),
      )
      .min(1)
      .max(MAX_RUN_FILE_SCOPE_PATHS)
      .refine((paths) => new Set(paths).size === paths.length, {
        message: 'fileScope must not repeat a path',
      })
      .optional(),
    outputSchema: z
      .record(z.string(), z.unknown())
      .superRefine((schema, context) => {
        const found = outputSchemaViolation(schema);
        if (found !== null) context.addIssue({ code: 'custom', message: found.message });
      })
      .optional(),
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
 * - `daily_cost_cap_reached` — the workspace has spent its policy ceiling's `maxCostPerDayUsd` of
 *   model cost today (UTC), so no run starts until the next UTC midnight; `429`, with the cap, the
 *   spend and the reset time in `details` (ADR-0102 SD6, issue #1851). Model responses with no
 *   price are stored at 0, so once any run with usage today is unmeasured the cap refuses the same
 *   way with `unpricedUsage: true` in `details`: a cap that cannot be measured is not met.
 * - `daily_cost_unavailable` — the daily cost cap is set but the workspace's spend could not be
 *   read, so the start is refused rather than let through; `503`, with no details (issue #1851).
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
 * - `run_attachments_unreadable` — the request attaches files but the agent cannot read files:
 *   `readFiles` is off, stored or capped by the policy ceiling (ADR-0146 Decision 4, issue #1307).
 *   Grant the agent `readFiles`, or send the request without `attachments`.
 * - `run_attachments_too_large` — an attached file is over 10 MiB, more than 20 attachments are
 *   named (a folder counts as one), or the attachments total over 50 MiB; the session's earlier
 *   uploads count too (the storage design, §04). Attach smaller files, or fewer. Judged before the
 *   run is created.
 * - `run_attachments_unsupported_runtime` — the request attaches files but the agent's runtime
 *   profile uses the `local` driver, which cannot be handed session files (ADR-0146 Decision 2).
 *   Use a runtime that hydrates session files, or send the request without `attachments`.
 * - `run_attachments_untranscribable` — the request attaches an audio file and the run's model
 *   connection is not one whose provider transcribes; today only `openai` does (issue #1313).
 *   Switch the run to an OpenAI connection, or attach a text transcript instead.
 *
 * - `run_file_scope_not_granted` — the request's `fileScope` names a path the agent is not granted
 *   (ADR-0147, issue #1539): a parent of a granted file, an unrelated path, or any path when the
 *   agent has no files. The scope narrows and never widens. It is judged when the run
 *   launches, against the agent's files after the policy ceiling, so the run fails with this code
 *   before any token is issued.
 * - `run_files_too_large` — the run's granted files, skills and attachments total more than the
 *   128 MiB a run may be handed (the storage design, §04 "Giving files to a run"); the message
 *   names the total and the limit. Grant fewer or smaller files. The start answers it, summed
 *   from the files' catalog sizes, before the run is queued; it is judged again when the run
 *   launches, before its runtime sandbox is created, so a run whose files grew in between fails
 *   with this code.
 * - `run_storage_grant_unavailable` — the agent's grant of a storage connection's folder cannot be
 *   delivered: the connection is gone, the folder is no longer one it allows, or its credential is
 *   missing (the storage design, §05). Fix the connection or redeploy the agent. Judged when the
 *   run launches.
 *
 * - `builder_model_unavailable` — the run is the built-in Builder's and no model connection serves
 *   the model it runs on. Add or fix a connection that offers it. Answered `503` before the run is
 *   created.
 *
 * The seventeen configuration codes are `422`: the request is well formed and the agent exists — it is
 * the workspace's configuration that cannot run it yet. The ceiling refusal is `403`: it refuses
 * what is asked rather than naming a missing piece (C14). The daily cost cap is `429`: the request
 * is fine and would be accepted after the reset; an unreadable spend is `503`.
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
  run_attachments_unreadable: 422,
  run_attachments_too_large: 422,
  run_attachments_unsupported_runtime: 422,
  run_attachments_untranscribable: 422,
  run_files_too_large: 422,
  run_storage_grant_unavailable: 422,
  /**
   * The request carries `subject` and the caller is not an API key (ADR-0142 D2): only a
   * server-to-server caller may say whom it acts for. A signed-in person is already identified.
   */
  run_subject_forbidden: 403,
  run_file_scope_not_granted: 403,
  /**
   * The run would exceed the policy ceiling (C14, ADR-0102 SD6, issue #524). `details` are the
   * `policyWidenings` of the run's configuration, in C14 order. It is answered whatever the
   * caller's role.
   */
  policy_cannot_widen: 403,
  /**
   * The workspace's model spend today (UTC) has reached the policy ceiling's `maxCostPerDayUsd`
   * (issue #1851). `details` are `capUsd: <n>`, `spentUsd: <n>` and `resetsAt: <ISO time>`, the
   * next UTC midnight, plus `unpricedUsage: true` when the refusal is because some of today's usage
   * has no price (it is stored as 0, so the spend cannot be measured).
   */
  daily_cost_cap_reached: 429,
  /**
   * The policy ceiling sets `maxCostPerDayUsd` and the workspace's spend today could not be read
   * (issue #1851). Fail-closed: the start is refused, with no `details` and no cause.
   */
  daily_cost_unavailable: 503,
  /**
   * The built-in Builder's model is served by no connection of the workspace (#1848).
   * `BUILDER_REFUSAL_CODES.builder_model_unavailable` takes its status from here, so the number
   * is written once.
   */
  builder_model_unavailable: 503,
} as const;

export type RunStartProblemCode = keyof typeof RUN_START_PROBLEM_CODES;

const RUN_START_PROBLEM_CODE_SET: ReadonlySet<string> = new Set(
  Object.keys(RUN_START_PROBLEM_CODES),
);

export function isRunStartProblemCode(value: string): value is RunStartProblemCode {
  return RUN_START_PROBLEM_CODE_SET.has(value);
}

/**
 * The refusals of `POST /api/agents/:id/runs` that come from its `Idempotency-Key` header
 * (ADR-0151). A start whose key is already held by the same request is not refused: it answers
 * `202` with the run that key started, whatever that run's status.
 *
 * - `invalid_idempotency_key` — the header is blank or longer than 255 characters.
 * - `run_idempotency_conflict` — this caller already used the key with a different request. Send
 *   a new key.
 */
export const RUN_IDEMPOTENCY_PROBLEM_CODES = {
  invalid_idempotency_key: 400,
  run_idempotency_conflict: 409,
} as const;

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
 * The run-failure code of a run whose engine could not produce a value that satisfies the
 * request's `outputSchema` (ADR-0143). The stored `error` is `output_schema_unsatisfied: ` followed
 * by {@link OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}, never the model's text or the schema. Not retryable
 * as is: the same prompt and schema will likely fail again.
 */
export const OUTPUT_SCHEMA_UNSATISFIED = 'output_schema_unsatisfied' as const;
export const OUTPUT_SCHEMA_UNSATISFIED_MESSAGE =
  'The run could not produce an answer that satisfies the requested output schema.';

/**
 * The run-failure code of a run whose granted file's stored bytes do not match its catalog row's
 * size or SHA-256 (the storage design, §04). The server checks each file while it streams the run's
 * files into the sandbox and stops at the first mismatch: storage-side corruption, so nothing
 * reached the agent. Not retryable as is; the file has to be uploaded again.
 */
export const RUN_FILE_CORRUPT = 'run_file_corrupt' as const;

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
    | typeof OUTPUT_SCHEMA_UNSATISFIED
    | typeof RUN_FILE_CORRUPT
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
    code === OUTPUT_SCHEMA_UNSATISFIED ||
    code === RUN_FILE_CORRUPT ||
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

/** The longest comment that may accompany an approval decision, in characters. */
export const RUN_APPROVAL_COMMENT_MAX_LENGTH = 1000;

/** The decisions `POST /api/runs/:id/approval` accepts. */
export const RUN_APPROVAL_DECISIONS = ['approve', 'reject'] as const;
export type RunApprovalDecision = (typeof RUN_APPROVAL_DECISIONS)[number];

/**
 * The body of `POST /api/runs/:id/approval` (ADR-0145): approve or reject the tool call a run
 * paused on, with an optional non-blank comment that reaches the continuation run's prompt.
 */
export const RunApprovalRequestSchema = z
  .object({
    decision: z.enum(RUN_APPROVAL_DECISIONS),
    comment: z
      .string()
      .max(RUN_APPROVAL_COMMENT_MAX_LENGTH)
      .refine((comment) => comment.trim().length > 0, { message: 'comment must not be blank' })
      .optional(),
  })
  .strict()
  .readonly();

export type RunApprovalRequest = z.infer<typeof RunApprovalRequestSchema>;

/**
 * The `202` body of `POST /api/runs/:id/approval`: the continuation run the decision started, in
 * the same session, and where to stream it from.
 */
export const RunApprovalResponseSchema = z
  .object({
    run: RunResourceSchema,
    /** Relative to the API origin: `/api/runs/:id/events`. Also sent as the `Location` header. */
    events: z.string().min(1),
  })
  .strict()
  .readonly();

export type RunApprovalResponse = z.infer<typeof RunApprovalResponseSchema>;

/** The refusals of `POST /api/runs/:id/approval` beyond the common ones, with their statuses. */
export const RUN_APPROVAL_PROBLEM_CODES = {
  run_not_awaiting_approval: 409,
  approval_already_decided: 409,
  approval_expired: 409,
} as const;

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
