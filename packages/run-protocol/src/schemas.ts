/**
 * `@agent-workspace/run-protocol` — the Zod schemas the UI, the database and the runner all validate
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

import {
  McpHttpServerConfigSchema,
  McpServerConfigSchema,
  McpSseServerConfigSchema,
  McpStdioServerConfigSchema,
  McpToolPolicySchema,
} from '@indx-workspace/contracts';
// The permission block is §17 Step 4, defined once in the contracts; the `agents.permissions`
// column in `@agent-workspace/core/db` reads the same schema, so the UI, the column and the
// compile step cannot drift.
import { AgentPermissionsSchema } from '@indx-workspace/contracts/agents';
import { DEFAULT_ENGINE_ID } from '@indx-workspace/contracts/engines';
import { RUNTIME_DRIVERS } from '@indx-workspace/contracts/runtimes';

import { describe } from './describe.js';
import {
  CLAUDE_CODE_PROJECT_DIR_NAME_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  sdkSettingSources,
  type TenantSessionScopeVerdict,
} from './types.js';

export const AgentPermissions = AgentPermissionsSchema;
export type AgentPermissions = z.infer<typeof AgentPermissions>;

/**
 * An MCP server name as it appears between the `mcp__` prefix and the `__<tool>` suffix. A single
 * `_` between two other characters is allowed (ADR-0113 SD13's `orders_2`); `__` and a leading or
 * trailing `_` are not, because each would make `mcp__<server>__<tool>` split in two places.
 */
const MCP_SERVER_NAME = /^[A-Za-z0-9](?:_?[A-Za-z0-9-])*$/;

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

export const McpToolPolicy = McpToolPolicySchema;
export const McpStdioServerConfig = McpStdioServerConfigSchema;
export const McpHttpServerConfig = McpHttpServerConfigSchema;
export const McpSseServerConfig = McpSseServerConfigSchema;
export const McpServerConfig = McpServerConfigSchema;
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
 * Spec §14.2's `RuntimeDriverId`: the contracts' `RUNTIME_DRIVERS`. The database `CHECK` in
 * `migrations/` is the one copy that cannot import it; `db/schema/runtime-profiles.test.ts` pins
 * that copy.
 */
export const runtimeDriverIds = RUNTIME_DRIVERS;
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
 * Resources selected by the control plane for exactly one run.
 *
 * These are deliberately part of the validated runner request rather than ambient files in the
 * runtime image.  A fresh runtime and a resumed runtime therefore receive the same explicit
 * allow-list, and the runner can remove a resource whose assignment was revoked between turns.
 * Files and skills are named by reference; the request never carries their contents.
 */
const RunResourcePath = z.string().min(1);

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * A granted file named by path, size and checksum, with no contents (the storage design, §04). The
 * bytes arrive through `POST /files`; the runner checks them on disk before the agent starts.
 */
export const RunFileReference = z
  .object({
    kind: z.literal('file'),
    path: RunResourcePath,
    access: z.enum(['read', 'read-write']),
    size: z.number().int().nonnegative(),
    sha256: Sha256Hex,
  })
  .strict();
export type RunFileReference = z.infer<typeof RunFileReference>;

export const RunFileResource = z.discriminatedUnion('kind', [
  RunFileReference,
  z
    .object({
      kind: z.literal('directory'),
      path: RunResourcePath,
      access: z.enum(['read', 'read-write']),
    })
    .strict(),
]);
export type RunFileResource = z.infer<typeof RunFileResource>;

/**
 * A granted skill named by file path, size and checksum, with no contents (the storage design,
 * §04). The archive places each file under `.aw-inbox/skills/<name>/`; the runner checks them there.
 */
export const RunSkillReference = z
  .object({
    name: SkillName,
    files: z
      .array(
        z
          .object({
            path: RunResourcePath,
            size: z.number().int().nonnegative(),
            sha256: Sha256Hex,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type RunSkillReference = z.infer<typeof RunSkillReference>;

export const RunResources = z
  .object({
    files: z.array(RunFileResource),
    skills: z.array(RunSkillReference),
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
    /**
     * The JSON Schema the run's final answer must satisfy (ADR-0143). A JSON object, typed loosely
     * on purpose: the dialect, depth and size limits are the public boundary's checks, not this
     * private body's.
     */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequest>;

// The Claude Agent SDK's event stream and its mapping onto the neutral frames live in their own
// module; they are re-exported by name so this module's public surface is unchanged.
export {
  AGENT_FRAME_RAW_MAX_BYTES,
  CLAUDE_AGENT_SDK_ENGINE,
  capAgentFrameRaw,
  classifyRunCost,
  classifySdkEvent,
  claudeToolKind,
  toAgentFrames,
} from './claude-sdk-events.js';
