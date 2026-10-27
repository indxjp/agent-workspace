import { z } from 'zod';

import { AGENT_PERMISSION_KEYS, type AgentPermissions } from './permissions.js';
import {
  AgentToolPolicySchema,
  RequireApprovalRuleSchema,
  conflictingApprovalRules,
} from './tool-rules.js';
import {
  ENGINE_CATALOGUE,
  isWithholdingEngine,
  type EngineCatalogue,
  type ToolRulesEngineId,
  type WithholdingEngineId,
} from '../engine-catalogue.js';
import { ENGINE_IDS, type EngineId } from '../engines.js';
import { SKILL_NAME_PATTERN } from '../skills.js';

/**
 * §17 Step 3 (skills): the tenant's skill surface. `{ mode: 'allowlist', names: [] }` is the
 * lever that lets an agent invoke none — `{ mode: 'all' }` is a distinct, wider choice, never the
 * default an absent policy implies. `names` reuses {@link SKILL_NAME_PATTERN}: a policy may only
 * name a skill whose name this platform could ever create.
 *
 * Either mode is bounded by the agent's own skill assignments when a run is composed:
 * `{ mode: 'all' }` means "every skill *currently assigned* to this agent", not every skill on the
 * image, and an allowlist loses any name whose assignment has since been revoked. See
 * {@link AgentPolicySchema}.
 */
export const AgentSkillPolicySchema = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('all') })
    .strict()
    .readonly(),
  z
    .object({
      mode: z.literal('allowlist'),
      names: z.array(z.string().regex(SKILL_NAME_PATTERN)).readonly(),
    })
    .strict()
    .readonly(),
]);
export type AgentSkillPolicy = z.infer<typeof AgentSkillPolicySchema>;

/** `maxTurns` / `maxBudgetUsd`, transcribed from `packages/run-protocol/src/schemas.ts`'s `AgentConfig`. */
export const AgentPolicyLimitsSchema = z
  .object({
    /** `null` means "the SDK's own default", not "unlimited". */
    maxTurns: z.number().int().positive().nullable(),
    /** `null` means "no per-run cap", which §20.6.3 budgets sit above. */
    maxBudgetUsd: z.number().positive().finite().nullable(),
  })
  .strict()
  .readonly();
export type AgentPolicyLimits = z.infer<typeof AgentPolicyLimitsSchema>;

/**
 * The portable core of a policy: the part **every** engine must honour, whatever harness runs the
 * agent loop (ADR-0065, #299's "portable core vs engine-native" table).
 *
 * It is spread into each arm of {@link AgentPolicySchema} rather than nested under a key, so the
 * wire shape is flat and unchanged for the fields that were already there. What the split buys is
 * a place to state, once, which fields a second engine may not reinterpret: `tools` is Claude's own
 * grammar and lives on the Claude arm; `skills` and `limits` are the platform's and live here.
 */
const PORTABLE_POLICY_FIELDS = {
  skills: AgentSkillPolicySchema,
  limits: AgentPolicyLimitsSchema,
} as const;

export const PortablePolicyBaseSchema = z.object(PORTABLE_POLICY_FIELDS).strict().readonly();
export type PortablePolicyBase = z.infer<typeof PortablePolicyBaseSchema>;

/** The arm of an engine that states narrowing in Claude's tool grammar. */
function toolRulesArm<const E extends ToolRulesEngineId>(engine: E) {
  const settings: EngineCatalogue[E]['settings'] = ENGINE_CATALOGUE[engine].settings;
  return z
    .object({
      engine: z.literal(engine),
      ...settings,
      /** Engine-native: the Claude Agent SDK's own tool grammar. No other arm may reuse it. */
      tools: AgentToolPolicySchema,
      /**
       * Tools whose every call waits for a human's approval (ADR-0145 D3). A tool that also matches
       * `tools.autoApprove` is refused: it could not both skip and wait. Absent means none.
       */
      requireApproval: z.array(RequireApprovalRuleSchema).readonly().optional(),
      /**
       * Offers the platform tool `handoff_to_person({ reason })`, which ends the run `completed`
       * after an `agent.handoff` frame (ADR-0145 D4). Absent means the tool is not offered.
       */
      handoff: z.literal(true).optional(),
      ...PORTABLE_POLICY_FIELDS,
    })
    .strict()
    .readonly();
}

/** The arm of an engine that states narrowing as `withheldPermissions`. */
function withholdingArm<const E extends WithholdingEngineId>(engine: E) {
  const settings: EngineCatalogue[E]['settings'] = ENGINE_CATALOGUE[engine].settings;
  return z
    .object({
      engine: z.literal(engine),
      ...settings,
      /**
       * Switches this policy turns **off** whatever the agent's checkbox says: a run composes the
       * agent's permissions with every key listed here set to `false`, so the adapter never offers
       * the tools they govern. Only ever narrows. It is where an engine switch from
       * `claude-agent-sdk` carries that arm's `tools.deny` and `permissionMode` narrowing
       * ({@link translatePolicyForEngineSwitch}, ADR-0074 D12). Absent means none.
       */
      withheldPermissions: z.array(z.enum(AGENT_PERMISSION_KEYS)).readonly().optional(),
      ...PORTABLE_POLICY_FIELDS,
    })
    .strict()
    .readonly();
}

/** `ENGINE_IDS` by position, so an arm names its engine without restating the id. */
const [claudeAgentSdk, openAiAgents, pi, mastra] = ENGINE_IDS;

/**
 * The `GET`/`PUT /api/agents/:id/policy` payload (S-13). `engine` is the discriminant — the harness
 * that runs the agent loop, never the model provider (`runs.provider`, `MODEL_PROVIDERS`). There are
 * four arms — `'claude-agent-sdk'`; since ENG-09 (#308), `'openai-agents'`, whose engine-native
 * fields are two model settings and no tool grammar; since ENG-08 (#307), `'pi'`, whose only
 * engine-native field is a thinking level; and since ENG-10 (#309), `'mastra'`, whose only
 * engine-native field is a tool-call concurrency — and a route refuses any other value as
 * `400 unsupported_engine` rather than accepting and ignoring it.
 *
 * The discriminant was called `provider` before ADR-0065, which is why a body carrying `provider`
 * is refused outright (`400 invalid_body`) rather than read as this shape: `provider` now means the
 * model provider everywhere else on the wire, and silently accepting it here would make one word
 * mean two things in the same request.
 *
 * A `PUT`'d policy is **strictly narrowing**: the server unions the agent's permission-derived
 * tool denials and read-only file denials into `tools.deny` rather than replacing them, and
 * intersects `skills` with the agent's current skill assignments, so this policy can restrict an
 * agent past its permission checkboxes but never widen it past them. See
 * `docs/adr/SDK-02-AGENT-POLICY-234-stored-policy-is-a-narrowing-jsonb-column.md`.
 *
 * **`GET` answers the base policy, not the effective one.** The body is the policy as stored, or —
 * for an agent nobody has `PUT` one onto — the policy derived from its permission checkboxes. Two
 * further layers are applied on top when a run is composed and are *not* reflected here: an
 * `mcp__<server>__*` auto-approval for every connector assigned to the agent, and
 * `Write(…)`/`Edit(…)`/`NotebookEdit(…)`/`Bash` denials for every read-only file grant. So
 * `tools.autoApprove` and `tools.deny` in this body are the base lists a run starts from, never
 * the full set a run ends up with; reading `autoApprove: []` does not mean no tool is
 * auto-approved at run time.
 */
export const AgentPolicySchema = z
  .discriminatedUnion('engine', [
    toolRulesArm(claudeAgentSdk),
    withholdingArm(openAiAgents),
    withholdingArm(pi),
    withholdingArm(mastra),
  ])
  .superRefine((policy, ctx) => {
    if (!('requireApproval' in policy)) return;
    const required = policy.requireApproval ?? [];
    for (const index of conflictingApprovalRules(policy.tools.autoApprove, required)) {
      ctx.addIssue({
        code: 'custom',
        path: ['requireApproval', index],
        message: `${JSON.stringify(required[index])} matches a tool in tools.autoApprove; a tool cannot both skip and wait for approval`,
      });
    }
  });

/** `true` when `A` and `B` are the same union of ids, else `never`. */
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * `AgentPolicy` collapses to `never` unless the arms above name exactly the ids of `ENGINE_IDS`, so
 * an engine added to the list without an arm (or an arm for an id the list lacks) fails typecheck
 * (ADR-0136).
 */
export type AgentPolicy =
  SameSet<z.infer<typeof AgentPolicySchema>['engine'], EngineId> extends never
    ? never
    : z.infer<typeof AgentPolicySchema>;

/**
 * Where the policy `GET`/`PUT /api/agents/:id/policy` answers comes from: `'stored'` when a `PUT`
 * has written one (it is then fixed until the next `PUT`), `'compiled'` when none has and the
 * server derived it from the agent's permission checkboxes and its assigned, enabled skills (it
 * then follows every later change to either). ADR-0076 D2 records why a client needs it: an export
 * must not turn a compiled policy into a stored one.
 */
export const AGENT_POLICY_SOURCES = ['stored', 'compiled'] as const;
export type AgentPolicySource = (typeof AGENT_POLICY_SOURCES)[number];

/**
 * The body of `GET`/`PUT /api/agents/:id/policy`. `source` is additive (ADR-0076 D2): a server
 * older than SDK unit 7 (#239) does not send it, so it is optional here, and a reader treats an
 * absent value as `'stored'` — the reading that never loses a policy.
 *
 * `connectorNames` is for a person reading the policy, and is never read back (ADR-0113 SD13): a
 * rule stored as `mcp__connector-<id>__<tool>` has its server `connector-<id>` mapped to the
 * connector's current key, so a view can show `mcp__connector-<id>__<tool> (<key>)`. It is
 * omitted when no rule names a connector that still exists with a key other than
 * `connector-<id>`, and `policy` is the stored value either way.
 */
export const AgentPolicyResponseSchema = z
  .object({
    policy: AgentPolicySchema,
    source: z.enum(AGENT_POLICY_SOURCES).optional(),
    connectorNames: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .readonly();
export type AgentPolicyResponse = z.infer<typeof AgentPolicyResponseSchema>;

/**
 * Problem codes the two policy routes (`GET`/`PUT /api/agents/:id/policy`) own, with the status each
 * one travels under. `engine_capability_unsupported` is also answered by the one-call
 * `POST /api/agents` with `assignments`, which saves an agent on the default engine and so runs the
 * same capability check before anything is written.
 */
export const AGENT_POLICY_PROBLEM_CODES = {
  /** The body failed to parse against {@link AgentPolicySchema} (the cross-field rule included). */
  invalid_policy: 400,
  /**
   * The body carries the pre-ADR-0065 `provider` discriminant. Told apart from
   * {@link AgentPolicyProblemCode}'s `invalid_policy` so a client on the old shape is answered with
   * the rename rather than a list of shape complaints about a missing `engine`.
   */
  invalid_body: 400,
  /** A parseable body whose `engine` is not one this deployment registers. */
  unsupported_engine: 400,
  /** A parseable `permissionMode: 'bypassPermissions'` policy; refused regardless of role. */
  dangerous_permission_mode_refused: 400,
  agent_not_found: 404,
  /** `skills.mode === 'allowlist'` names a skill the agent has no assignment for. */
  skill_not_assigned: 409,
  /**
   * The agent's engine — the one the `PUT` body names, or the default engine for a one-call create
   * — cannot honour a connector or a skill this agent is assigned. The refusal's single `details`
   * entry is the capability (`ENGINE_CAPABILITY_KEYS`, `./engines.ts`); for `claude-agent-sdk` it
   * never fires, because that engine honours both.
   */
  engine_capability_unsupported: 422,
  /**
   * The `PUT` changes the policy's `engine`, and the stored arm narrows the agent in a way the new
   * engine's arm cannot express, so applying it would widen what the agent may do. `details` names
   * each untranslatable item — a `tools.deny` rule, verbatim. Anything that can be carried across
   * is, and a switch that only carries is applied ({@link translatePolicyForEngineSwitch}).
   */
  engine_switch_would_widen: 422,
  /**
   * The policy asks for more than the deployment's policy ceiling allows (C14, ADR-0102 SD6,
   * issue #524). `details` are the `policyWidenings` of the saved configuration, in C14 order —
   * `permissions.<key>`, `limits.maxTurns`, `limits.maxBudgetUsd`, `engine:<id>`, `model:<id>`,
   * `tool:<name>`. It is answered whatever the caller's role.
   */
  policy_cannot_widen: 403,
  agent_policy_not_configured: 503,
} as const;
export type AgentPolicyProblemCode = keyof typeof AGENT_POLICY_PROBLEM_CODES;

/** An arm that states narrowing as `withheldPermissions` rather than as a tool grammar. */
export type WithholdingArm = Extract<AgentPolicy, { engine: WithholdingEngineId }>;

export function isWithholdingArm(policy: AgentPolicy): policy is WithholdingArm {
  return isWithholdingEngine(policy.engine);
}

/**
 * The permissions a run composes: the agent's, with every switch the stored `openai-agents`, `pi`
 * or `mastra` arm withholds turned off. Only ever narrows.
 */
export function policyNarrowedPermissions(
  permissions: AgentPermissions,
  policy: AgentPolicy | null,
): AgentPermissions {
  if (policy === null || !isWithholdingArm(policy) || policy.withheldPermissions === undefined) {
    return permissions;
  }
  const withheld = policy.withheldPermissions;
  return {
    readFiles: permissions.readFiles && !withheld.includes('readFiles'),
    writeFiles: permissions.writeFiles && !withheld.includes('writeFiles'),
    runCommands: permissions.runCommands && !withheld.includes('runCommands'),
    unrestrictedNetwork:
      permissions.unrestrictedNetwork && !withheld.includes('unrestrictedNetwork'),
  };
}

/**
 * The engine-native settings `policy` carries: the subset of its keys the engine's catalogue entry
 * lists as `settings`, in the catalogue's order. Absent keys stay absent, and `skills`, `limits`,
 * `tools` and `withheldPermissions` are never part of the answer. `{}` for no stored policy.
 */
export function engineSettingsOf(policy: AgentPolicy | null): Readonly<Record<string, unknown>> {
  if (policy === null) return {};
  const fields: Readonly<Record<string, unknown>> = policy;
  const settings: Record<string, unknown> = {};
  for (const key of Object.keys(ENGINE_CATALOGUE[policy.engine].settings)) {
    const value = fields[key];
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}
