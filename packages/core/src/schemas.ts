/**
 * `@agent-workspace/core` — the Zod schemas the UI, the database and the runner all validate
 * through (spec §5, §6, §17; R-01 §3, §4, §7, §9, §10).
 *
 * Two rules run through every schema below, and both come from ADR-0015 (the orchestrator's
 * record; cited by name because this branch does not carry the file):
 *
 *   1. **Parse before you compare.** Every validator here takes `unknown` and establishes the
 *      type before it looks at the value. `NaN`, `undefined` and `null` never reach a
 *      comparison.
 *   2. **Every classifier ends in a total, explicit branch that REJECTS and names what it
 *      rejected.** A value this file does not understand is an error with a sentence attached,
 *      never a value that quietly takes the permissive path.
 *
 * Objects are `.strict()` throughout, for the reason `db/schema/agents.ts` already gives: an
 * unknown key is a setting the compile step of §5 does not know how to map onto an SDK option,
 * and dropping it silently is the failure mode ADR-0015 exists to forbid.
 */
import { z } from 'zod';

import { capFrameRaw, engineFrameBuilder, type EngineFrameBuilder } from '@agent-workspace/engine';
import { DEFAULT_ENGINE_ID } from '@indx-workspace/contracts/engines';

// The permission block is §17 Step 4 and is already defined — once — by the table that stores
// it. Importing it rather than restating it costs this module a dependency on the db schema
// graph and buys the guarantee that the UI, the column and the compile step cannot drift.
import { AgentPermissions } from './db/schema/agents.js';
import {
  CLAUDE_CODE_PROJECT_DIR_NAME_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  sdkResultSubtypes,
  sdkSettingSources,
  sdkSystemSubtypes,
  sdkEventTypes,
  type AgentFrame,
  type AgentMessageBlock,
  type AgentStopReason,
  type AgentToolKind,
  type AgentUsageFrame,
  type ClassifiedSdkEvent,
  type RunCostVerdict,
  type SdkEventEnvelope,
  type SdkEventType,
  type SdkModelUsage,
  type SdkResultSubtype,
  type SdkSystemSubtype,
  type TenantSessionScopeVerdict,
} from './types.js';

export { AgentPermissions };

/** Name a value in an error message without stringifying something huge or throwing on a cycle. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  // The `typeof` tests are repeated rather than hoisted into a variable so TypeScript narrows
  // `value` for the `String()` call; a hoisted `const t = typeof value` does not narrow, and
  // stringifying an un-narrowed `unknown` is how '[object Object]' ends up in an error message.
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  if (typeof value === 'bigint') return `the bigint ${String(value)}`;
  return `a value of type ${typeof value}`;
}

/**
 * An MCP server name as it appears between the `mcp__` prefix and the `__<tool>` suffix. A single
 * `_` between two other characters is allowed (ADR-0113 SD13's `orders_2`); `__` and a leading or
 * trailing `_` are not, because each would make `mcp__<server>__<tool>` split in two places.
 */
const MCP_SERVER_NAME = /^[A-Za-z0-9](?:_?[A-Za-z0-9-])*$/;

/** The prefix of every MCP tool name; `claudeToolKind` classifies on it. */
const MCP_PREFIX = 'mcp__';

/**
 * The SDK's setting sources as a schema. Suffixed `Schema` because `types.ts` already exports
 * {@link SdkSettingSource} as a type, and one name cannot mean both across two modules. The
 * tool-rule grammar and the permission modes live in `@indx-workspace/contracts/agents`.
 */
export const SdkSettingSourceSchema = z.enum(sdkSettingSources);

// ── Skills (spec §7; R-01 §3, §8, contract summary) ─────────────────────────────────────

/**
 * A skill directory name, validated against the rules R-01's contract summary lists for the
 * SDK's pre-spawn validator — *"no empty, no `()`/`,`/control chars, no surrounding whitespace,
 * no bare `*`, no `:*` suffix, no leading `/`, no `\\`, no trailing `\`"* — plus the obvious
 * path-traversal rejections a multi-tenant control plane owes itself, since §7 materialises
 * this name as a directory under the tenant's workspace.
 */
export const SkillName = z.string().superRefine((value, ctx) => {
  const reject = (reason: string): void => void ctx.addIssue({ code: 'custom', message: reason });
  if (value.length === 0) return reject('a skill name must not be empty');
  if (value !== value.trim())
    return reject(`the skill name ${JSON.stringify(value)} has surrounding whitespace`);
  // Control characters are checked by code point rather than by a regex: a literal control
  // character inside a character class is invisible in a diff and makes this file non-text to
  // git, and an escaped spelling of one trips `no-control-regex` — a rule this repository does
  // not let anyone suppress.
  for (const ch of value) {
    const point = ch.codePointAt(0);
    if (point === undefined || point < 0x20 || point === 0x7f) {
      return reject(`the skill name ${JSON.stringify(value)} contains a control character`);
    }
  }
  if (/[(),]/.test(value))
    return reject(`the skill name ${JSON.stringify(value)} contains '(', ')' or ','`);
  if (value === '*') return reject("'*' is not a skill name");
  if (value.endsWith(':*')) return reject(`the skill name ${JSON.stringify(value)} ends with ':*'`);
  if (value.startsWith('/'))
    return reject(`the skill name ${JSON.stringify(value)} starts with '/'`);
  if (value.includes('\\'))
    return reject(`the skill name ${JSON.stringify(value)} contains a backslash`);
  if (value === '.' || value === '..' || value.includes('/../') || value.startsWith('../')) {
    return reject(`the skill name ${JSON.stringify(value)} traverses the filesystem`);
  }
});

/**
 * The tenant's skill surface.
 *
 * R-01 contradiction 6 is why this is modelled on the `skills` option and not on
 * `settingSources`: spec §7's claim that `settingSources: []` empties a tenant's skill surface
 * is **factually wrong** — probe 2 ran with `settingSources: []` and still received 17 bundled
 * Claude Code skills. `{ mode: 'allowlist', names: [] }` is the lever that lets Claude invoke
 * none. Note R-01 §3's other caveat: this is a *context filter, not a sandbox* — unlisted skill
 * files remain on disk and are reachable via Read/Bash.
 */
export const AgentSkillPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('allowlist'), names: z.array(SkillName) }).strict(),
]);
export type AgentSkillPolicy = z.infer<typeof AgentSkillPolicy>;

// ── MCP connectors (R-01 §9) ────────────────────────────────────────────────────────────

/**
 * The record key in `mcpServers`, which R-01 §9 records as the name that appears inside tool
 * names as `mcp__<server>__<tool>`. `__` is therefore banned in it: a server called `a__b`
 * makes `mcp__a__b__c` ambiguous, and an ambiguous permission rule is a permission rule that
 * decides the wrong way.
 */
export const McpServerName = z.string().superRefine((value, ctx) => {
  if (!MCP_SERVER_NAME.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: `${JSON.stringify(value)} is not a usable MCP server name: expected a letter or digit followed by letters, digits, hyphens or single underscores.`,
    });
  }
});

export const McpToolPolicy = z
  .object({
    name: z.string().min(1),
    permission_policy: z.enum(['always_allow', 'always_ask', 'always_deny']).optional(),
    org_max_permission: z.enum(['allow', 'ask', 'blocked']).optional(),
  })
  .strict();

/** R-01 §9: `timeout` under 1000 ms is ignored by the SDK, so storing one is storing a lie. */
const McpTimeout = z.number().int().min(1000).optional();

export const McpStdioServerConfig = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
    timeout: McpTimeout,
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

export const McpHttpServerConfig = z
  .object({
    type: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    tools: z.array(McpToolPolicy).optional(),
    timeout: McpTimeout,
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

export const McpSseServerConfig = McpHttpServerConfig.extend({ type: z.literal('sse') }).strict();

/**
 * R-01 §9: JSON config files accept `"streamable-http"` as an alias for `"http"`, but
 * `McpHttpServerConfig` declares only `"http"` — *"so the platform must normalise to `http` on
 * save"*. Normalising here means a connector imported from a `.mcp.json` is stored in the one
 * spelling the SDK's type accepts.
 */
function normaliseMcpServerConfig(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record['type'] === 'streamable-http') return { ...record, type: 'http' };
  return value;
}

export const McpServerConfig = z.preprocess(
  normaliseMcpServerConfig,
  z.union([McpHttpServerConfig, McpSseServerConfig, McpStdioServerConfig]),
);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

// ── The agent (spec §17) ────────────────────────────────────────────────────────────────

/** One subagent of a run (ADR-0133 D14). Mirrors `EngineSubagent` in `@agent-workspace/engine`. */
export const PortableSubagentConfig = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    instructions: z.string(),
    model: z.string().min(1).nullable(),
    permissions: AgentPermissions,
  })
  .strict();
export type PortableSubagentConfig = z.infer<typeof PortableSubagentConfig>;

/**
 * What the UI collects and the database stores for one agent — spec §17's five steps, minus
 * Step 3, whose table does not exist yet — **restricted to what every engine must honour**.
 *
 * Step 3's *files* is absent because `agent_files` is not yet a table (see `db/schema/agents.ts`);
 * a field here that no column backs would be a promise this wave cannot keep. Declared as a gap on
 * this task's PR. Step 5's *runtime profile* is no longer in that state: W3-CP-06 added
 * `runtime_profiles` and the `agents.runtime_profile_id` column it references, in the same edit
 * that adds the `runtimeProfileId` field below.
 *
 * ## Why there is no `tools` here any more (ENG-04b, #325)
 *
 * This was `AgentConfig`, and it carried §17 Step 4's SDK-facing detail — `AgentToolPolicy` (now `@indx-workspace/contracts/agents`'s `AgentToolPolicySchema`),
 * whose `base`/`autoApprove`/`deny` are `@anthropic-ai/claude-agent-sdk`'s own tool names. That
 * made the private `/run` contract Claude-shaped in the one field a second engine could not
 * reinterpret: an engine with different tool names would have received a policy written in another
 * engine's vocabulary and had to guess. #299's "portable core vs engine-native" table draws the
 * line here, and ENG-04b moves it: the portable core is this, the engine-native arm is
 * {@link RunRequest.policy}, and the tool policy a run ends up with is compiled by the engine's own
 * adapter from `permissions` plus that arm.
 */
export const PortableAgentConfig = z
  .object({
    /** §17 Step 1. */
    name: z.string().min(1),
    /** §17 Step 1. Empty means "no extra instructions", matching the `agents.instructions` column. */
    instructions: z.string(),
    /** §17 Step 2. `null` means the workspace default model (see the `agents.model` column). */
    model: z.string().min(1).nullable(),
    /**
     * §17 Step 5 / §14.9. The id of a `RuntimeProfile` row (`agents.runtime_profile_id`) — a
     * **reference**, never the profile's fields inlined; §14.9's reversibility rule is explicit
     * about this ("Runtime selection therefore stores a profile reference, never a copy of the
     * profile").
     *
     * `.optional()` rather than nullable-and-required, unlike `model` above, so that a fixture
     * built before this field existed keeps parsing unchanged. An absent key and an explicit
     * `null` both mean the same thing §15.1 already
     * gives a "no profile chosen" agent: the selected driver's own defaults apply.
     */
    runtimeProfileId: z.string().min(1).nullable().optional(),
    /**
     * §17 Step 4, the human-facing summary, shared with the `agents.permissions` column — and,
     * since ENG-04b, the **only** tool-permission input on the wire. Each engine's adapter maps
     * these four booleans onto its own tool vocabulary.
     */
    permissions: AgentPermissions,
    /** §17 Step 3 (skills). See {@link AgentSkillPolicy}. */
    skills: AgentSkillPolicy,
    /** §17 Step 3 (connectors). */
    mcpServers: z.record(McpServerName, McpServerConfig),
    limits: z
      .object({
        /** `maxTurns`. `null` means "the SDK's own default", not "unlimited". */
        maxTurns: z.number().int().positive().nullable(),
        /** `maxBudgetUsd`. `null` means "no per-run cap", which §20.6.3 budgets sit above. */
        maxBudgetUsd: z.number().positive().finite().nullable(),
      })
      .strict(),
    /** Sent only when non-empty, so a request without subagents is byte-identical to before. */
    subagents: z.array(PortableSubagentConfig).max(20).optional(),
  })
  .strict();
export type PortableAgentConfig = z.infer<typeof PortableAgentConfig>;

// ── Runtime profiles (spec §15.1) ───────────────────────────────────────────────────────

/**
 * Spec §14.2's `RuntimeDriverId`, duplicated here rather than imported from
 * `@agent-workspace/runtime`. `packages/core` may gain no dependency this level (ADR-0041). This
 * is one of FOUR hand-typed copies of the same ten values, not three: `packages/runtime/src/driver.ts`'s
 * own copy, `packages/core/src/db/schema/runtime-profiles.ts`'s `runtimeProfileDrivers` (its
 * `CHECK` constraint, for the identical reason — a database constraint cannot reference a
 * TypeScript type), and — the one that is easy to miss, and the one round 2's new gate did not
 * pin — the literal value list `drizzle-kit generate` compiled into
 * `migrations/0002_w3_runtime_profiles.sql`'s committed `CHECK` text, which is what a real
 * database actually enforces. `schemas.test.ts` pins the two copies in this package equal to each
 * other. `db/schema/runtime-profiles.test.ts` (W3-CP-06-B4) pins all four: its first `describe`
 * reads `docs/spec.md` §14.2's own union at test time and pins it against `runtimeDriverIds` and
 * `runtimeProfileDrivers` — `RuntimeDriverId` in `packages/runtime` is a `type`, not a `const`, so
 * the spec text is the only value either of this package's copies can be compared against without
 * a dependency this level forbids, and `packages/runtime/src/spec-transcription.test.ts` pins
 * `driver.ts` to that same spec text from its own side. Its second `describe` (added round 3)
 * parses the committed migration's `CHECK` constraint directly and pins it to
 * `runtimeProfileDrivers`, closing the gap that let a driver added everywhere in TypeScript still
 * reach a real database and fail with `23514` at a driver task's integration.
 */
export const runtimeDriverIds = [
  'local',
  'sandbox-runtime',
  'docker',
  'kubernetes',
  'gke-agent-sandbox',
  'aca-sessions',
  'aws-agentcore',
  'aws-ecs',
  'cloud-run-sandbox',
  'cloud-run-service',
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
] as const;
export type RuntimeDriverId = (typeof runtimeDriverIds)[number];

/**
 * Spec §15.1's `RuntimeProfile`, verbatim in member names and optionality — this task's own copy,
 * validated with Zod because the Wave 3 plan's 3a-2 cell gives that clause to this task
 * rather than to `packages/runtime` (ADR-0042: `packages/runtime` may declare no runtime
 * dependency, and `zod` already resolves here). `driverConfig` is validated only as "a plain
 * object" — §15.1 calls it "validated per driver with Zod", and no driver's own `driverConfig`
 * shape exists yet in this wave (the drivers land at sub-waves 3b and 3c); per-driver validation
 * is a declared gap on this task's PR, not something this schema pretends to do.
 */
export const RuntimeProfile = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    driver: z.enum(runtimeDriverIds),
    /** Which stored runtime connection (cluster, session pool, ECR image...) to use. */
    runtimeConnectionId: z.string().min(1).optional(),
    cpu: z.number().positive().finite().optional(),
    memoryMb: z.number().int().positive().safe().optional(),
    diskMb: z.number().int().positive().safe().optional(),
    networkPolicy: z.enum(['none', 'restricted', 'open']),
    allowedDomains: z.array(z.string().min(1)).optional(),
    filesystem: z.enum(['read-only', 'read-write']),
    persistPaths: z.array(z.string().min(1)).optional(),
    timeoutSeconds: z.number().int().positive().safe().optional(),
    idleTimeoutSeconds: z.number().int().positive().safe().optional(),
    /** Escape hatch. Validated per driver with Zod, hidden under "Advanced". See this file's note. */
    driverConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RuntimeProfile = z.infer<typeof RuntimeProfile>;

/**
 * What `POST /api/runtime-profiles` accepts: everything but the server-assigned `id`.
 * `allowedDomains: null` is accepted as "none", the value a profile reads back (BH061-080).
 */
export const CreateRuntimeProfileInput = RuntimeProfile.omit({ id: true }).extend({
  allowedDomains: z.array(z.string().min(1)).nullable().optional(),
});
export type CreateRuntimeProfileInput = z.infer<typeof CreateRuntimeProfileInput>;

/** What `PATCH /api/runtime-profiles/:id` accepts: any subset of the creatable fields. */
export const UpdateRuntimeProfileInput = CreateRuntimeProfileInput.partial();
export type UpdateRuntimeProfileInput = z.infer<typeof UpdateRuntimeProfileInput>;

// ── Session identity (R-01 §7) ──────────────────────────────────────────────────────────

/**
 * The SDK's own validator for `CLAUDE_CODE_PROJECT_DIR_NAME`, transcribed from the resolver in
 * the shipped `sdk.mjs` (R-01 §7): `/^[A-Za-z0-9_-]{1,64}$/`, rejecting Windows device names.
 *
 * `tests/sdk-surface.test.ts` extracts both regexes from the installed bundle and re-runs this
 * function's cases against them, so a transcription slip or an upstream change breaks a test.
 */
const SDK_PROJECT_DIR_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SDK_WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Decide whether a run may start under a given tenant session scope.
 *
 * **Both of the SDK's failure modes here are silent** (R-01 §7 rules 1 and 2), which is why
 * this exists at all:
 *
 *   * `CLAUDE_CODE_PROJECT_DIR_NAME` that fails the SDK's own regex, or names a Windows
 *     device, is *ignored* — the SDK falls back to the sanitised `cwd`;
 *   * `CLAUDE_CODE_PROJECT_DIR_NAME` set **without** `CLAUDE_CONFIG_DIR` is ignored for the
 *     same reason: the resolver short-circuits.
 *
 * In both cases two tenants whose sandboxes share a workspace path end up sharing one session
 * key namespace — the exact cross-tenant collision the override exists to prevent (spec §25).
 * Nothing throws and nothing is logged, so the platform cannot learn about it afterwards: the
 * check has to happen **before the run starts**, and it has to be ours.
 *
 * ADR-0015 shape: the verdict is a positive assertion. The scope is usable because both inputs
 * were parsed and matched, never because nothing objected.
 */
export function validateTenantSessionScope(input: unknown): TenantSessionScopeVerdict {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      reason: `a tenant session scope must be an object; got ${describe(input)}`,
    };
  }
  const record = input as Record<string, unknown>;
  const projectKey = record['projectKey'];
  const configDir = record['configDir'];

  if (typeof configDir !== 'string') {
    return {
      ok: false,
      reason: `${CLAUDE_CONFIG_DIR_ENV} must be a string; got ${describe(configDir)}. Without it the SDK ignores ${CLAUDE_CODE_PROJECT_DIR_NAME_ENV} entirely and keys the session under the sanitised cwd (R-01 §7 rule 1).`,
    };
  }
  if (configDir.trim().length === 0) {
    return {
      ok: false,
      reason: `${CLAUDE_CONFIG_DIR_ENV} is empty. The SDK's resolver treats that as unset and ignores ${CLAUDE_CODE_PROJECT_DIR_NAME_ENV}, silently keying the session under the sanitised cwd (R-01 §7 rule 1).`,
    };
  }
  const key = validateTenantProjectKey(projectKey);
  if (!key.ok) return key;
  return { ok: true, projectKey: key.projectKey, configDir };
}

/**
 * Whether this value may be a tenant namespace, with the same sentences the pair validator used.
 *
 * Split out of {@link validateTenantSessionScope} by ENG-04b (#325), when the private `/run`
 * contract stopped carrying a `configDir`: the config directory is *the engine's own* — the Claude
 * adapter derives `${cwd}/.claude` from its own `protectedConfigDirectory` — while the project key
 * is the **platform's** tenant namespace, and every engine's session store is keyed by it. So the
 * pair validator keeps both halves and {@link RunProjectKey} validates this one alone, through this
 * function, because one rule with two spellings is two rules.
 *
 * A verdict rather than a nullable reason, so the caller narrows the type it returns instead of
 * asserting it: the `ok` arm carries the `string` the checks proved it to be.
 */
function validateTenantProjectKey(
  projectKey: unknown,
):
  | { readonly ok: true; readonly projectKey: string }
  | { readonly ok: false; readonly reason: string } {
  if (typeof projectKey !== 'string') {
    return {
      ok: false,
      reason: `${CLAUDE_CODE_PROJECT_DIR_NAME_ENV} must be a string; got ${describe(projectKey)}.`,
    };
  }
  if (!SDK_PROJECT_DIR_NAME.test(projectKey)) {
    return {
      ok: false,
      reason: `${CLAUDE_CODE_PROJECT_DIR_NAME_ENV}=${JSON.stringify(projectKey)} fails the SDK's own validator /^[A-Za-z0-9_-]{1,64}$/. The SDK would ignore it silently and key this session under the sanitised cwd, colliding with any other tenant on the same workspace path (R-01 §7 rule 2).`,
    };
  }
  if (SDK_WINDOWS_DEVICE_NAME.test(projectKey)) {
    return {
      ok: false,
      reason: `${CLAUDE_CODE_PROJECT_DIR_NAME_ENV}=${JSON.stringify(projectKey)} is a reserved Windows device name. The SDK ignores it silently, with the same cross-tenant collision (R-01 §7 rule 2).`,
    };
  }
  return { ok: true, projectKey };
}

/** The validated scope, as a schema, for the engine adapter that derives the pair. */
export const TenantSessionScope = z
  .object({ projectKey: z.string(), configDir: z.string() })
  .strict()
  .superRefine((value, ctx) => {
    const verdict = validateTenantSessionScope(value);
    if (!verdict.ok) ctx.addIssue({ code: 'custom', message: verdict.reason });
  });
export type TenantSessionScope = z.infer<typeof TenantSessionScope>;

/**
 * The tenant namespace one run's session state is keyed under, as the private `/run` contract
 * carries it (ENG-04b, #325).
 *
 * It replaces the `scope: { projectKey, configDir }` pair the contract carried until ENG-04b. The
 * config directory left the wire because it was `${cwd}/.claude` — one engine's directory name,
 * chosen by the control plane, for an engine the control plane does not import. The engine's
 * adapter derives it now, from `cwd` and its own
 * `AgentEngine.protectedConfigDirectory`, so the string is identical and only one module names it.
 *
 * The *validation* stays here, and stays strict, for the reason
 * {@link validateTenantSessionScope} gives: a key the Claude SDK would silently ignore collapses
 * two tenants onto one session namespace (spec §25, R-01 §7 rule 2), and the platform cannot learn
 * about it afterwards. A future engine with a laxer key rule inherits the stricter one, which is
 * the safe direction.
 */
export const RunProjectKey = z.string().superRefine((value, ctx) => {
  const verdict = validateTenantProjectKey(value);
  if (!verdict.ok) ctx.addIssue({ code: 'custom', message: verdict.reason });
});

/**
 * How this run relates to a Claude session (R-01 §6).
 *
 * Three arms rather than four loose optional fields, because the SDK's rule — `sessionId`
 * *"cannot be combined with `continue` or `resume` unless `forkSession` is also set"* — is an
 * invariant, and an invariant expressed as a union cannot be violated by a caller. R-01 §6 also
 * records why `fresh` mints the id on our side: it removes the race between the Postgres row
 * and the arrival of `system/init`.
 */
export const RunSessionMode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fresh'), sessionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('resume'), resume: z.uuid() }).strict(),
  z.object({ kind: z.literal('fork'), resume: z.uuid(), sessionId: z.uuid() }).strict(),
]);
export type RunSessionMode = z.infer<typeof RunSessionMode>;

/**
 * The environment the subprocess will run with.
 *
 * R-01 §3's first trap: `options.env` **REPLACES** the subprocess environment; it is not merged
 * with `process.env`. That makes this field the complete environment, and it makes the runner —
 * not this schema — responsible for spreading whatever the subprocess still needs (`PATH`,
 * `HOME`, credentials). The two session-scope variables are rejected here so they can only ever
 * come from {@link TenantSessionScope}: two sources for one value is two values.
 */
const RESERVED_RUN_ENVIRONMENT_NAMES = [
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CODE_PROJECT_DIR_NAME_ENV,
  'AGENT_WORKSPACE_RUN_ID',
  'AGENT_WORKSPACE_SESSION_ID',
  'ANTHROPIC_API_KEY',
] as const;

const ParsedRunEnvironment = z.record(z.string().min(1), z.string()).superRefine((value, ctx) => {
  const seen = new Map<string, string>();
  for (const name of Object.keys(value)) {
    const canonicalName = name.toUpperCase();
    const previous = seen.get(canonicalName);
    if (previous !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `environment names are case-insensitive on Windows; ${JSON.stringify(name)} duplicates ${JSON.stringify(previous)}.`,
      });
    }
    seen.set(canonicalName, name);
  }
  for (const reserved of RESERVED_RUN_ENVIRONMENT_NAMES) {
    const supplied = seen.get(reserved);
    if (supplied === undefined) continue;
    ctx.addIssue({
      code: 'custom',
      message:
        reserved === 'ANTHROPIC_API_KEY'
          ? `${JSON.stringify(supplied)} must not be set in env; environment names are case-insensitive on Windows and provider master credentials never enter a sandbox.`
          : `${JSON.stringify(supplied)} must not be set in env; it case-insensitively collides with reserved variable ${reserved}, whose value is derived by the platform.`,
    });
  }
});

export const RunEnvironment = z
  .unknown()
  .superRefine((value, ctx) => {
    // Zod's record parser constructs an ordinary object and therefore silently loses an own
    // `__proto__` key through the legacy prototype setter. Refuse it before parsing rather than
    // compiling an environment different from the one the caller supplied.
    if (
      typeof value === 'object' &&
      value !== null &&
      Object.prototype.hasOwnProperty.call(value, '__proto__')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '__proto__ is not a supported run environment name.',
      });
    }
  })
  .pipe(ParsedRunEnvironment);

/**
 * Resource bytes selected by the control plane for exactly one run.
 *
 * These are deliberately part of the validated runner request rather than ambient files in the
 * runtime image.  A fresh runtime and a resumed runtime therefore receive the same explicit
 * allow-list, and the runner can remove a resource whose assignment was revoked between turns.
 */
const RunResourcePath = z.string().min(1);
const RunResourceContent = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const RunFileResource = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      path: RunResourcePath,
      contentBase64: RunResourceContent,
      access: z.enum(['read', 'read-write']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('directory'),
      path: RunResourcePath,
      access: z.enum(['read', 'read-write']),
    })
    .strict(),
]);
export type RunFileResource = z.infer<typeof RunFileResource>;

export const RunSkillResource = z
  .object({
    name: SkillName,
    files: z
      .array(z.object({ path: RunResourcePath, contentBase64: RunResourceContent }).strict())
      .min(1),
  })
  .strict();
export type RunSkillResource = z.infer<typeof RunSkillResource>;

export const RunResources = z
  .object({
    files: z.array(RunFileResource),
    skills: z.array(RunSkillResource),
  })
  .strict();
export type RunResources = z.infer<typeof RunResources>;

/**
 * The model connection a run reaches, as the private `/run` contract carries it (ENG-04, #303).
 *
 * Until this unit the runner learned about the gateway only by reading `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN` out of `env` — two variables named after one engine's bundled CLI, in a
 * field that is otherwise the tenant's. That works while there is one engine and stops working
 * at the second: an engine whose SDK takes a connection as a parameter would have to have it
 * reconstructed from environment variables it never reads.
 *
 * So the connection is a field. `protocol` is the ingress the gateway serves this run's model
 * connection over, which is what lets compose refuse — before a run starts — an engine that
 * cannot speak any protocol the gateway offers for that provider
 * (`engine_model_protocol_unsupported`).
 *
 * `token` is the short-lived, run-scoped bearer, never a provider credential; `@agent-workspace/engine`'s
 * `sandboxEnvironmentVerdict` is the check that says so about the compiled environment.
 */
export const RunGatewayConnection = z
  .object({
    baseUrl: z.url(),
    token: z.string().min(1),
    /**
     * The wire protocol, as `@indx-workspace/contracts`' `WIRE_PROTOCOLS` names it. Restated as
     * a bare non-empty string rather than imported: `packages/core` may not depend on
     * `packages/contracts` (the rule `agentFrameNames` records above), and a duplicated enum
     * whose two copies could disagree is worse than a string the compose-side check validates
     * against the catalogue it already holds.
     */
    protocol: z.string().min(1),
  })
  .strict();
export type RunGatewayConnection = z.infer<typeof RunGatewayConnection>;

/**
 * The engine id a `/run` body is addressed to.
 *
 * `.default()` rather than required, and that is a migration decision rather than a preference:
 * the runner and the control plane ship together but are *deployed* separately during a rollout,
 * so for one window a new runner receives bodies an old control plane composed. Defaulting to
 * the one engine that existed before ENG-04 makes that window a run on the right engine instead
 * of a `400`. Typed as a string for the same reason {@link RunGatewayConnection.protocol} is;
 * the registry's own lookup is what decides whether an id names an installed adapter, and it
 * answers `engine_not_installed` when it does not.
 */
export const DEFAULT_RUN_ENGINE = DEFAULT_ENGINE_ID;

/**
 * One execution of one agent — everything an engine adapter's compile step needs.
 *
 * ## v2: a portable core and one engine-native arm (ENG-04b, #325)
 *
 * Until ENG-04b this body carried `agent: AgentConfig` and `scope: TenantSessionScope`, and both
 * were Claude-shaped: `agent.tools` is the Claude Agent SDK's tool vocabulary and `scope.configDir`
 * is `${cwd}/.claude`. The control plane therefore had to know one engine's tool names and one
 * engine's directory layout in order to compose a run for *any* engine — which is the thing #299
 * set out to remove, and which ENG-04 (#324) recorded as its Deviations 7 and 8.
 *
 * So the body is split, exactly along #299's "portable core vs engine-native" line:
 *
 *   * {@link portable} is what **every** engine must honour — the agent's name, instructions,
 *     model, the four permission booleans, its skill surface, its connectors and its limits.
 *   * {@link policy} is the engine-native arm, `unknown` here and parsed by the adapter the
 *     request is addressed to. `packages/engine`'s `EngineRunRequest.policy` documents why a trust
 *     boundary's shape is not a shape until its owner has parsed it.
 *
 * This is a **breaking** change to the private contract, unlike ENG-04's defaulted `engine` and
 * optional `gateway`. It is breaking because it has to be: a body that carried both shapes would
 * need the control plane to compile the Claude arm as well, which is the code this unit removes.
 * The runner and the control plane ship together (#303), so the rollout requirement is that they
 * are *deployed* together for this release; `docs/adr/0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md`
 * records the decision and the operational consequence.
 */
export const RunRequest = z
  .object({
    /** The platform's own run id (`runs.id`), for correlation. */
    runId: z.uuid(),
    /** `sessions.id`. The engine-side identity is in {@link RunSessionMode}. */
    sessionId: z.uuid(),
    /** The sandbox workspace root — the engine's working directory. */
    cwd: z.string().min(1),
    prompt: z.string().min(1),
    /** Which engine runs this request. See {@link DEFAULT_RUN_ENGINE} for why it defaults. */
    engine: z.string().min(1).default(DEFAULT_RUN_ENGINE),
    /** The tenant namespace this run's session state is keyed under. See {@link RunProjectKey}. */
    projectKey: RunProjectKey,
    /** What every engine must honour. See {@link PortableAgentConfig}. */
    portable: PortableAgentConfig,
    /**
     * The engine-native arm, addressed to {@link engine}'s adapter and to nothing else.
     *
     * Deliberately not validated here, and deliberately not `z.record(...)`: only the adapter knows
     * what its own engine's policy means, and a schema in this package that guessed would either
     * refuse a valid policy for an engine it has not heard of or accept a malformed one. The
     * adapter answers `engine_policy_invalid` — a typed refusal with a stable code — for an arm it
     * cannot read, which is what the runner turns into a `run-error` before any output frame.
     */
    policy: z.unknown(),
    session: RunSessionMode,
    env: RunEnvironment,
    /**
     * The gateway this run's model calls go through. Optional for the rollout window described
     * on {@link DEFAULT_RUN_ENGINE}; a body without it is a pre-ENG-04 body whose credential is
     * still in `env`, and every adapter refuses it — the Claude adapter too, since the token it
     * would find there cannot vouch for itself.
     */
    gateway: RunGatewayConnection.optional(),
    /** Only resources assigned to this agent when the run was composed. */
    resources: RunResources.optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequest>;

// ── The event stream (R-01 §4) ──────────────────────────────────────────────────────────

const SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(sdkSystemSubtypes);
const RESULT_SUBTYPES: ReadonlySet<string> = new Set(sdkResultSubtypes);
const EVENT_TYPES: ReadonlySet<string> = new Set(sdkEventTypes);

/**
 * Classify one raw event off the SDK's iterator. **Never throws.**
 *
 * R-01 §4's implementer rule, implemented: discriminate on `type`, then on `subtype` for
 * `system` and `result`, and keep a default branch that forwards an unrecognised discriminant
 * opaquely — *"the subtype set grows in patch releases"*, and probe 2 already received a
 * `system/thinking_tokens` message from a run that set no thinking options.
 *
 * The ADR-0015 distinction this function exists to make: **"unknown" and "malformed" are not
 * the same answer.** An unrecognised `type` or `subtype` on a well-formed envelope is expected
 * and is forwarded. An event that is not an object, or whose discriminant is not a string, is
 * *rejected by name* — it never reaches the opaque-forward path, because falling through to a
 * forward on malformed input is a gate deciding on the absence of a negative.
 */
export function classifySdkEvent(raw: unknown): ClassifiedSdkEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      kind: 'malformed',
      reason: `an SDK event must be an object; got ${describe(raw)}`,
      event: raw,
    };
  }
  const record = raw as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string') {
    return {
      kind: 'malformed',
      reason: `an SDK event must carry a string 'type'; got ${describe(type)}`,
      event: raw,
    };
  }
  if (type === '') {
    // An empty `type` names nothing. Forwarded opaquely it would become an `agent.native` frame
    // whose `type` the contract refuses (`min(1)`), which is a dropped message by another route —
    // so it is refused here, by name, like any other discriminant that is not one.
    return {
      kind: 'malformed',
      reason: `an SDK event must carry a non-empty 'type'; got ${describe(type)}`,
      event: raw,
    };
  }
  const event = record as SdkEventEnvelope;

  if (type === 'system' || type === 'result') {
    const subtype = record['subtype'];
    if (typeof subtype !== 'string') {
      return {
        kind: 'malformed',
        reason: `a '${type}' event must carry a string 'subtype'; got ${describe(subtype)}`,
        event: raw,
      };
    }
    if (type === 'system') {
      return SYSTEM_SUBTYPES.has(subtype)
        ? { kind: 'system', subtype: subtype as SdkSystemSubtype, event }
        : { kind: 'system-unknown', subtype, event };
    }
    return RESULT_SUBTYPES.has(subtype)
      ? { kind: 'result', subtype: subtype as SdkResultSubtype, carriesUsage: true, event }
      : { kind: 'result-unknown', subtype, carriesUsage: true, event };
  }

  if (EVENT_TYPES.has(type)) {
    return { kind: 'event', type: type as Exclude<SdkEventType, 'system' | 'result'>, event };
  }
  return { kind: 'unknown', type, event };
}

/**
 * Decide whether one `ModelUsage` row may be presented to a user as money (spec §12).
 *
 * R-01 §4: `costBasis: 'unknown'` means no pricing row matched the model id and `costUSD` is a
 * guess at the default model's rate; an absent `costBasis` is to be read as `'list'`. Anything
 * else — including a `costUSD` that is not a finite number — is unpriced with a reason. Note
 * that `NaN` is parsed for before it is compared: `NaN >= 0` is `false`, so a guard written the
 * other way round would have let it through.
 */
export function classifyRunCost(usage: unknown): RunCostVerdict {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    return { priced: false, reason: `usage must be an object; got ${describe(usage)}` };
  }
  const record = usage as Partial<SdkModelUsage>;
  const basis = record.costBasis ?? 'list';
  if (basis === 'unknown') {
    return {
      priced: false,
      reason:
        "costBasis is 'unknown': no pricing row matched this model id, so costUSD is a guess at the default model's rate (R-01 §4). Show the run as unpriced, never as a number.",
    };
  }
  if (basis !== 'list' && basis !== 'managed') {
    return {
      priced: false,
      reason: `unrecognised costBasis ${describe(basis)}; treat the run as unpriced.`,
    };
  }
  const cost = record.costUSD;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    return {
      priced: false,
      reason: `costUSD must be a finite non-negative number; got ${describe(cost)}`,
    };
  }
  return { priced: true, costUsd: cost, basis };
}

// ── The Claude Agent SDK → neutral frames mapping (ENG-03, #302) ─────────────────────────

/** The Claude engine's id, as the frames this module produces name it. */
export const CLAUDE_AGENT_SDK_ENGINE = DEFAULT_ENGINE_ID;

/**
 * Which ACP tool kind each Claude Agent SDK built-in tool has.
 *
 * Only tools whose effect is *known* appear. Everything else — including a tool this build has not
 * heard of — is `other`, which is the honest answer rather than a default that would present an
 * unmapped `Bash`-like tool as harmless. `mcp__…` is decided by its prefix, not by this table,
 * because a connector's tool names are the tenant's.
 *
 * `delete` and `move` are in the neutral vocabulary (ACP has them) and no Claude built-in maps onto
 * them: the SDK deletes and moves through `Bash`, which is an `execute`. Naming them here anyway
 * would claim a fidelity the SDK does not offer.
 */
const CLAUDE_TOOL_KINDS: Readonly<Record<string, AgentToolKind>> = {
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  KillBash: 'execute',
};

/** The ACP kind of one Claude tool name. Never throws, and never guesses anything but `other`. */
export function claudeToolKind(name: string): AgentToolKind {
  if (name.startsWith(MCP_PREFIX)) return 'mcp';
  return CLAUDE_TOOL_KINDS[name] ?? 'other';
}

/**
 * The neutral stop reason for one `result` subtype.
 *
 * `error_max_structured_output_retries` is an `error`, not its own reason: it is the SDK failing to
 * get a parseable answer, which is a failure of the turn and not a limit the platform set. An
 * unrecognised subtype is also an `error` — R-01 §4 records that the set grows in patch releases,
 * and a subtype this build cannot name is a turn whose outcome it cannot claim went well.
 *
 * `refusal` and `cancelled` are in the neutral set and are not produced here: the SDK reports a
 * refusal as a `system` message rather than a result (so it reaches `agent.native`), and a
 * cancellation is the control plane's own transition, recorded as `run.status`.
 */
function claudeStopReason(subtype: string): AgentStopReason {
  switch (subtype) {
    case 'success':
      return 'end_turn';
    case 'error_max_turns':
      return 'max_turns';
    case 'error_max_budget_usd':
      return 'max_budget';
    default:
      return 'error';
  }
}

/**
 * The largest engine-native payload one frame's `raw` may carry, in UTF-8 bytes.
 *
 * The runner-side copy of `@indx-workspace/contracts`' `AGENT_FRAME_RAW_MAX_BYTES`, restated for
 * the reason {@link agentFrameNames} gives and compared against it by
 * `apps/web/server/sdk-conformance.test.ts`. The contract publishes the number and the marker shape
 * because a consumer needs both; the cap is applied by the port's `capFrameRaw`.
 */
export const AGENT_FRAME_RAW_MAX_BYTES = 65_536;

/**
 * Cap one engine-native payload for carriage in a frame's `raw` (never throws; an oversized or
 * unserialisable payload becomes the contract's truncation marker). The port's `capFrameRaw` is
 * the one implementation (ADR-0070 D4, amended by #958); this name stays for
 * `apps/web/server/runs/` and the contract's documentation.
 */
export { capFrameRaw as capAgentFrameRaw } from '@agent-workspace/engine';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The Claude CLI appends its own notes to the model (`<system-reminder>…</system-reminder>`) to
 * some tool results. They are not the tool's output, so a trace never shows them (BH061-062).
 */
const SYSTEM_REMINDER = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/gu;

/**
 * A tool result's `content` as one string: a string as itself, blocks by their text parts, with
 * the CLI's system reminders left out.
 */
function flattenToolOutput(content: unknown): string {
  if (typeof content === 'string') return content.replace(SYSTEM_REMINDER, '');
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part): string[] => {
      const block = asRecord(part);
      const text = block?.['text'];
      return block?.['type'] === 'text' && typeof text === 'string' ? [text] : [];
    })
    .join('\n')
    .replace(SYSTEM_REMINDER, '');
}

/** The prose blocks of one Messages-API `content`, in the order the model returned them. */
function proseBlocks(content: unknown): readonly AgentMessageBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value): AgentMessageBlock[] => {
    const block = asRecord(value);
    const type = block === null ? null : block['type'];
    const text = block?.['text'];
    if (type === 'text' && typeof text === 'string') return [{ type: 'text', text }];
    // `thinking` is the Messages API's name for the model's reasoning; the neutral vocabulary
    // calls it `reasoning` because that is what every engine's version of it is.
    if (type === 'thinking') {
      const thinking = block?.['thinking'];
      if (typeof thinking === 'string') return [{ type: 'reasoning', text: thinking }];
    }
    return [];
  });
}

/**
 * Sum the `modelUsage` records of one `result` message.
 *
 * R-01 §4's three traps are respected: `thinkingTokens` is *already inside* `outputTokens`, so it
 * is reported as `reasoningTokens` and never added again; the record key is unstable, so every
 * entry is summed rather than one being picked; and results are cumulative within a `query()` call,
 * so this reads the latest message rather than accumulating across them.
 *
 * `null` when no entry is readable — an engine that reported nothing is not an engine that
 * reported zero.
 */
function claudeUsage(
  envelope: SdkEventEnvelope,
): Omit<AgentUsageFrame, 'frame' | 'engine' | 'raw'> | null {
  const modelUsage = asRecord(envelope['modelUsage']);
  if (modelUsage === null) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: number | null = null;
  let cacheCreation: number | null = null;
  let reasoning: number | null = null;
  let entries = 0;
  for (const value of Object.values(modelUsage)) {
    const usage = asRecord(value);
    if (usage === null) continue;
    const input = asCount(usage['inputTokens']);
    const output = asCount(usage['outputTokens']);
    if (input === null || output === null) continue;
    entries += 1;
    inputTokens += input;
    outputTokens += output;
    const read = asCount(usage['cacheReadInputTokens']);
    if (read !== null) cacheRead = (cacheRead ?? 0) + read;
    const creation = asCount(usage['cacheCreationInputTokens']);
    if (creation !== null) cacheCreation = (cacheCreation ?? 0) + creation;
    const thinking = asCount(usage['thinkingTokens']);
    if (thinking !== null) reasoning = (reasoning ?? 0) + thinking;
  }
  if (entries === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    reasoningTokens: reasoning,
  };
}

/** The tool-use and tool-result frames one message's `content` carries, in the model's order. */
function toolFrames(
  role: 'assistant' | 'user',
  content: unknown,
  b: EngineFrameBuilder,
  raw: unknown,
): AgentFrame[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value): AgentFrame[] => {
    const block = asRecord(value);
    if (block === null) return [];
    if (role === 'assistant' && block['type'] === 'tool_use') {
      const toolCallId = asNonEmptyString(block['id']);
      const name = asNonEmptyString(block['name']);
      if (toolCallId === null || name === null) return [];
      return [
        b.toolCall(
          {
            frame: 'agent.tool.call',
            toolCallId,
            name,
            kind: claudeToolKind(name),
            // The contract's `input` key is always present on the wire, and JSON has no spelling
            // for `undefined`: a `tool_use` block without an input is sent as `null`.
            input: block['input'] ?? null,
          },
          raw,
        ),
      ];
    }
    if (role === 'user' && block['type'] === 'tool_result') {
      const toolCallId = asNonEmptyString(block['tool_use_id']);
      if (toolCallId === null) return [];
      // `status` is whether the call ran, `isError` the engine's verdict on its answer. The Claude
      // SDK delivers a result block for both, so a delivered block always ran to completion.
      return [
        b.toolResult(
          {
            frame: 'agent.tool.result',
            toolCallId,
            status: 'completed',
            output: flattenToolOutput(block['content']),
            isError: block['is_error'] === true,
          },
          raw,
        ),
      ];
    }
    return [];
  });
}

/**
 * The name `agent.native` gives one classified event, so the engine's own word for the message
 * survives in a field a consumer can branch on.
 */
function nativeName(event: ClassifiedSdkEvent): string {
  switch (event.kind) {
    case 'system':
    case 'system-unknown':
      return `system/${event.subtype}`;
    case 'result':
    case 'result-unknown':
      return `result/${event.subtype}`;
    case 'event':
    case 'unknown':
      return event.type;
    case 'malformed':
      return 'malformed';
    default: {
      const unhandled: never = event;
      return `unclassified/${String(unhandled)}`;
    }
  }
}

/**
 * Map one classified Claude Agent SDK message onto the neutral `agent.*` frames (ADR-0065 D5,
 * `docs/sdk/04-api-specification.md` §6.3). **Pure, and never throws.**
 *
 * This is the one place the Claude vocabulary is read. It is the function the runner calls on a
 * live event and the function `apps/web/server/runs/` calls to upgrade a `run_events` row recorded
 * before ENG-03, which is why it lives beside {@link classifySdkEvent} rather than in either
 * application — and it is what ENG-04 (#303) moves into `packages/engine-claude-agent-sdk`.
 *
 * Two guarantees, both tested and both proved in `formal/AgentWorkspace/Events/AgentFrames.lean`:
 *
 *   1. **Nothing is dropped.** The returned list is never empty. A message with no neutral meaning
 *      becomes `agent.native`, and one that could not be parsed becomes `agent.malformed`; there is
 *      no path that returns `[]` for an event that arrived.
 *   2. **Tool results are paired.** A `tool_result` block only ever rides on a `user` message and a
 *      `tool_use` block only on an `assistant` one, so within a run the `agent.tool.call` naming a
 *      `toolCallId` always precedes the `agent.tool.result` that answers it.
 *
 * Every frame is built through the port's `engineFrameBuilder` (ADR-0070 D4, amended by #958), so
 * `engine` and the capped `raw` are set by the one implementation every adapter shares. `raw`
 * carries the engine-native message, capped by {@link capAgentFrameRaw}: a tenant's agent chooses
 * how large a tool result is, and `raw` is the one field it can make arbitrarily big.
 */
export function toAgentFrames(
  event: ClassifiedSdkEvent,
  engine: string = CLAUDE_AGENT_SDK_ENGINE,
): readonly AgentFrame[] {
  // The engine-native message, whatever it turned out to be — `unknown` on the `malformed` arm,
  // which is exactly the case where a consumer most wants to see what arrived.
  //
  // Every frame of the message carries it, not only the first. That multiplies storage for a
  // message that fans out (each frame is a `run_events` row, bounded by the cap per copy), and it
  // is deliberate: a frame is read on its own — by a consumer that resumed inside a message, by one
  // that only reads `agent.result`, by the upgraded legacy path — and a frame whose engine-native
  // source lived on a sibling it may never see would make `raw` an escape hatch that only works
  // sometimes. `docs/sdk/04-api-specification.md` §6.3 states the cost.
  const b = engineFrameBuilder(engine);
  // Capped once per event: the builder caps again per frame, which is then cheap (≤ 64 KiB, or
  // the marker) instead of re-serialising an arbitrarily large message once per fan-out frame.
  const raw = capFrameRaw(event.event);

  if (event.kind === 'malformed') return [b.malformed(event.reason, raw)];

  // `payload` is `raw` on this frame (the builder sets both): `agent.native` *is* "the
  // engine-native message, uninterpreted", so its own field and the uniform escape hatch name the
  // same value. A consumer branching on `frame === 'agent.native'` reads `payload`; one walking
  // every frame uniformly reads `raw`; neither has to know about the other.
  const native = (): readonly AgentFrame[] => [b.native(nativeName(event), raw)];

  if (event.kind === 'system') {
    if (event.subtype !== 'init') return native();
    const engineSessionId = asNonEmptyString(event.event['session_id']);
    // A `system/init` without a session id is not a session: it is an init message this build
    // cannot read, and claiming a session from it would put an empty id into `sessions`.
    if (engineSessionId === null) return native();
    return [
      b.session(
        {
          frame: 'agent.session',
          engineSessionId,
          model: asNonEmptyString(event.event['model']),
        },
        raw,
      ),
    ];
  }

  if (event.kind === 'result' || event.kind === 'result-unknown') {
    const usage = claudeUsage(event.event);
    const cost = event.event['total_cost_usd'];
    const turns = asCount(event.event['num_turns']);
    const frames: AgentFrame[] = [];
    if (usage !== null) frames.push(b.usage({ frame: 'agent.usage', ...usage }, raw));
    frames.push(
      b.result(
        {
          frame: 'agent.result',
          stopReason: claudeStopReason(event.subtype),
          turns,
          engineCostUsd:
            typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
        },
        raw,
      ),
    );
    return frames;
  }

  if (event.kind === 'event' && (event.type === 'assistant' || event.type === 'user')) {
    const role = event.type;
    const message = asRecord(event.event['message']);
    if (message === null) return native();
    const content = message['content'];
    const blocks = proseBlocks(content);
    const frames: AgentFrame[] = [];
    if (blocks.length > 0) {
      frames.push(
        b.message(
          {
            frame: 'agent.message',
            // An assistant turn is identified by the model's message id, which repeats when the
            // SDK re-sends a grown snapshot; a user turn has no message id of its own, so the
            // SDK's per-message `uuid` is the only stable handle on it.
            messageId: asNonEmptyString(role === 'assistant' ? message['id'] : event.event['uuid']),
            role,
            blocks,
          },
          raw,
        ),
      );
    }
    frames.push(...toolFrames(role, content, b, raw));
    // A message that carried neither prose nor a tool block — an image-only turn, say — still
    // happened. `agent.native` is what keeps it in the log instead of returning nothing.
    return frames.length > 0 ? frames : native();
  }

  return native();
}
