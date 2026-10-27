import { z } from 'zod';

import {
  AGENT_DEFINITION_MAX_REFERENCES,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PERMISSION_KEYS,
  type AgentPermissionKey,
  type AgentPermissions,
  type AgentPolicyLimits,
} from './agents.js';
import { type EngineId, EngineIdSchema } from './engines.js';
import type { RuntimeNetworkPolicy } from './runtimes.js';

/**
 * Issue #524 (S2-01a), ADR-0102 SD6, C13 and C14: a project's policy **ceiling** — the most any
 * agent of the deployment may do, whatever the caller's role — and the two pure functions every
 * write path and the compose step judge it with.
 *
 * This module imports agents, engines, the runtime network-policy type and zod only. The project
 * file imports it (not the other way round), so the ceiling has one definition the file, the local
 * runtime's `start` message and the server's `AW_DEPLOYMENT_POLICY` all parse with (C13). Both
 * functions are pure and deterministic, so the formal model of the ceiling can pin them with
 * vectors.
 */

/** The most model ids a ceiling's `models` allowlist may name (issue #524). */
export const POLICY_CEILING_MODELS_MAX = 64;

/**
 * The longest connector name a ceiling's `tools` allowlist may name: the catalogue's connector
 * name bound (`CONNECTOR_NAME_MAX_LENGTH`), because a ceiling may name a connector made in the UI,
 * not only one the project file declares (issue #524).
 */
export const POLICY_CEILING_TOOL_NAME_MAX_LENGTH = 200;

/** The largest `maxCostPerDayUsd` a ceiling may set: a sanity bound, not a recommendation. */
const POLICY_CEILING_MAX_COST_PER_DAY_USD = 100_000;

/** No C0 control, DEL or C1 control: `\p{Cc}` is exactly that set. */
const NO_CONTROL_CHARACTER_PATTERN = /^\P{Cc}*$/u;

function isDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const DISTINCT_MESSAGE = 'must not name a value twice';

function notBuilt(key: string): z.ZodOptional<z.ZodNever> {
  return z.never({ error: `${key} is not built yet (ADR-0102 SD6); remove it` }).optional();
}

/**
 * The permission switches a ceiling may turn off, one optional boolean per
 * `AGENT_PERMISSION_KEYS` key. `false` caps the switch off; `true` or absent leaves it to the
 * agent (ADR-0102 SD6, issue #524).
 */
export const ProjectPolicyPermissionsSchema = z
  .object({
    readFiles: z.boolean().optional(),
    writeFiles: z.boolean().optional(),
    runCommands: z.boolean().optional(),
    unrestrictedNetwork: z.boolean().optional(),
  })
  .strict()
  .readonly();
export type ProjectPolicyPermissions = z.infer<typeof ProjectPolicyPermissionsSchema>;

/**
 * The per-run limits a ceiling caps. A ceiling names a number or nothing: `null` ("the engine's
 * default" or "no cap") is an agent's value, never a ceiling's (ADR-0102 SD6, issue #524).
 */
export const ProjectPolicyLimitsSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().finite().optional(),
  })
  .strict()
  .readonly();
export type ProjectPolicyLimits = z.infer<typeof ProjectPolicyLimitsSchema>;

/**
 * The promotion gate's bar (issue #619): the least share of an evaluation's cases, from 0 to 1, a
 * version must pass before `production` may point at it. It judges no agent configuration, so
 * neither {@link policyWidenings} nor {@link meetPolicyCeiling} reads it.
 */
export const ProjectPolicyPromotionSchema = z
  .object({ minEvalScore: z.number().min(0).max(1) })
  .strict()
  .readonly();
export type ProjectPolicyPromotion = z.infer<typeof ProjectPolicyPromotionSchema>;

/**
 * An agent name in `builder.allow`. Agent names are stored trimmed (`CreateAgentInputSchema`), so a
 * name with whitespace at either edge could never match one and is refused instead of normalised.
 */
const BuilderAgentNameSchema = z
  .string()
  .min(1)
  .max(AGENT_NAME_MAX_LENGTH, { abort: true })
  .regex(NO_CONTROL_CHARACTER_PATTERN, 'must not contain a control character')
  .refine((name) => name.trim() === name, 'must not start or end with whitespace');

/**
 * Which agents may build agents (issue #1851): the names of the agents whose runs may use the
 * Builder's `aw-control` tools. It judges no agent configuration, so neither
 * {@link policyWidenings} nor {@link meetPolicyCeiling} reads it, and no widening check is needed:
 * unlike the narrowing keys above, a longer list grants more rather than capping an agent.
 */
export const ProjectPolicyBuilderSchema = z
  .object({
    allow: z
      .array(BuilderAgentNameSchema)
      .max(AGENT_DEFINITION_MAX_REFERENCES)
      .readonly()
      .refine(isDistinct, DISTINCT_MESSAGE),
  })
  .strict()
  .readonly();
export type ProjectPolicyBuilder = z.infer<typeof ProjectPolicyBuilderSchema>;

/**
 * A project's policy ceiling (ADR-0102 SD6, C13, C14, issue #524). Every key is optional, and an
 * absent key caps nothing:
 *
 * - `permissions` — a switch set to `false` may not be on in any agent.
 * - `limits` — `maxTurns` and `maxBudgetUsd` no agent may exceed.
 * - `engines` — the engines an agent may run on, at least one, none twice.
 * - `models` — the **model ids** an agent may name, never connection names (a connection carries no
 *   model id, C11). At least one, none twice, at most {@link POLICY_CEILING_MODELS_MAX}, and no
 *   control character (a ceiling is printed, as `tools` is).
 * - `tools` — the connector names an agent may use, none twice. An empty list means no tools.
 * - `promotion` — `minEvalScore`, the bar promotion to `production` must reach (issue #619). It is
 *   not a widening of any agent: unset, promotion needs no evaluation.
 * - `maxCostPerDayUsd` — the model spend, in USD, a workspace may run up per UTC day (issue #1851).
 *   Like `promotion` it is not a widening of any agent: a run start over it is refused
 *   `daily_cost_cap_reached`.
 * - `builder` — `allow`, the names of the agents that may build agents (issue #1851). It is not a
 *   widening of any agent either. An absent `builder` allows no agent (fail closed), and an empty
 *   `allow` says the same.
 *
 * `network` and `approval` are not built yet and are each refused at their own path. `connections`
 * has no field: an allowlist of connections is out of scope in slice 2, so the strict object
 * refuses it as an unknown key.
 */
export const ProjectPolicySchema = z
  .object({
    permissions: ProjectPolicyPermissionsSchema.optional(),
    limits: ProjectPolicyLimitsSchema.optional(),
    engines: z
      .array(EngineIdSchema)
      .min(1)
      .readonly()
      .refine(isDistinct, DISTINCT_MESSAGE)
      .optional(),
    models: z
      .array(
        z
          .string()
          .min(1)
          .max(AGENT_MODEL_MAX_LENGTH, { abort: true })
          .regex(NO_CONTROL_CHARACTER_PATTERN, 'must not contain a control character'),
      )
      .min(1)
      .max(POLICY_CEILING_MODELS_MAX)
      .readonly()
      .refine(isDistinct, DISTINCT_MESSAGE)
      .optional(),
    tools: z
      .array(
        z
          .string()
          .min(1)
          .max(POLICY_CEILING_TOOL_NAME_MAX_LENGTH, { abort: true })
          .regex(NO_CONTROL_CHARACTER_PATTERN, 'must not contain a control character'),
      )
      .max(AGENT_DEFINITION_MAX_REFERENCES)
      .readonly()
      .refine(isDistinct, DISTINCT_MESSAGE)
      .optional(),
    promotion: ProjectPolicyPromotionSchema.optional(),
    maxCostPerDayUsd: z.number().positive().max(POLICY_CEILING_MAX_COST_PER_DAY_USD).optional(),
    builder: ProjectPolicyBuilderSchema.optional(),
    network: notBuilt('network'),
    approval: notBuilt('approval'),
  })
  .strict()
  .readonly();

/** A parsed {@link ProjectPolicySchema} (ADR-0102 SD6, issue #524). */
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

/**
 * Whether `ceiling` lets the agent named `agentName` build agents (issue #1851). Fails closed: an
 * absent or `null` ceiling, an absent `builder` or an unlisted name allows nothing. Pure.
 */
export function builderAllows(
  ceiling: ProjectPolicy | null | undefined,
  agentName: string,
): boolean {
  return ceiling?.builder?.allow.includes(agentName) ?? false;
}

/**
 * The configuration a ceiling judges at one step (C14, issue #524): an agent's permissions and
 * limits, its engine, the one model id the caller can judge there and the connector names it uses.
 *
 * `model` is an explicit model, the deployment default, the model resolved at compose or a run's
 * `modelOverride` — whichever the step knows (ADR-0102 SD6). `null` means there is no model to judge
 * at this step, so none is refused.
 */
export interface EffectivePolicyConfiguration {
  readonly permissions: AgentPermissions;
  readonly limits: AgentPolicyLimits;
  readonly engine: EngineId;
  readonly model: string | null;
  readonly tools: readonly string[];
}

/**
 * One `details` entry of `403 policy_cannot_widen` (C14, issue #524): the field the configuration
 * asks for above the ceiling.
 */
export type PolicyWidening =
  | `permissions.${AgentPermissionKey}`
  | 'limits.maxTurns'
  | 'limits.maxBudgetUsd'
  | `engine:${EngineId}`
  | `model:${string}`
  | `tool:${string}`;

function exceeds(value: number | null, cap: number | undefined): boolean {
  return value !== null && cap !== undefined && value > cap;
}

function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Where `effective` asks for more than `ceiling` allows, in C14's fixed order (issue #524,
 * ADR-0102 SD6):
 *
 * 1. `permissions.<key>`, in `AGENT_PERMISSION_KEYS` order, for each switch on where the ceiling
 *    sets it `false`;
 * 2. `limits.maxTurns`, then `limits.maxBudgetUsd`, for an explicit limit above the ceiling's — a
 *    `null` limit never refuses, because it composes at the ceiling;
 * 3. `engine:<id>` when the engine is outside `engines`;
 * 4. `model:<id>` when the model is not `null` and outside `models`;
 * 5. `tool:<name>` for each distinct connector outside `tools`, in ascending code-unit order, so the
 *    answer does not depend on the order the tools were read in.
 *
 * An absent or `null` ceiling, or an absent key, gives no detail. Each field is named at most once.
 * An empty result means nothing widens. Pure: the same inputs always give the same list.
 */
export function policyWidenings(
  effective: EffectivePolicyConfiguration,
  ceiling: ProjectPolicy | null | undefined,
): readonly PolicyWidening[] {
  if (ceiling === null || ceiling === undefined) return Object.freeze([]);
  const widenings: PolicyWidening[] = [];

  const permissions = ceiling.permissions;
  for (const key of AGENT_PERMISSION_KEYS) {
    if (effective.permissions[key] && permissions?.[key] === false) {
      widenings.push(`permissions.${key}`);
    }
  }

  if (exceeds(effective.limits.maxTurns, ceiling.limits?.maxTurns)) {
    widenings.push('limits.maxTurns');
  }
  if (exceeds(effective.limits.maxBudgetUsd, ceiling.limits?.maxBudgetUsd)) {
    widenings.push('limits.maxBudgetUsd');
  }

  if (ceiling.engines !== undefined && !ceiling.engines.includes(effective.engine)) {
    widenings.push(`engine:${effective.engine}`);
  }

  if (
    effective.model !== null &&
    ceiling.models !== undefined &&
    !ceiling.models.includes(effective.model)
  ) {
    widenings.push(`model:${effective.model}`);
  }

  const allowedTools = ceiling.tools;
  if (allowedTools !== undefined) {
    const allowed = new Set(allowedTools);
    const outside = [...new Set(effective.tools)].filter((tool) => !allowed.has(tool));
    for (const tool of outside.sort(byCodeUnit)) widenings.push(`tool:${tool}`);
  }

  return Object.freeze(widenings);
}

function cappedLimit(value: number | null, cap: number | undefined): number | null {
  if (cap === undefined) return value;
  return value === null ? cap : Math.min(value, cap);
}

/**
 * The configuration at or below both `effective` and `ceiling` (C14, issue #524, ADR-0102 SD6). It
 * returns a frozen result and does not change its inputs:
 *
 * - each permission is on only when it is on in `effective` and the ceiling does not set it
 *   `false`;
 * - each limit is the smaller of the two, and a `null` limit composes at the ceiling's value;
 * - `tools` keeps, in input order, only the connectors the ceiling's `tools` allows.
 *
 * The engine and the model are returned unchanged, because neither can be narrowed: the caller
 * refuses them instead. So `policyWidenings(meetPolicyCeiling(e, c), c)` is exactly the `engine:`
 * and `model:` entries of `policyWidenings(e, c)`. A `null` or absent ceiling returns `effective`
 * itself.
 */
export function meetPolicyCeiling(
  effective: EffectivePolicyConfiguration,
  ceiling: ProjectPolicy | null | undefined,
): EffectivePolicyConfiguration {
  if (ceiling === null || ceiling === undefined) return effective;

  const caps = ceiling.permissions;
  const permissions: AgentPermissions = Object.freeze({
    readFiles: effective.permissions.readFiles && caps?.readFiles !== false,
    writeFiles: effective.permissions.writeFiles && caps?.writeFiles !== false,
    runCommands: effective.permissions.runCommands && caps?.runCommands !== false,
    unrestrictedNetwork:
      effective.permissions.unrestrictedNetwork && caps?.unrestrictedNetwork !== false,
  });
  const limits: AgentPolicyLimits = Object.freeze({
    maxTurns: cappedLimit(effective.limits.maxTurns, ceiling.limits?.maxTurns),
    maxBudgetUsd: cappedLimit(effective.limits.maxBudgetUsd, ceiling.limits?.maxBudgetUsd),
  });
  const allowedTools = ceiling.tools;
  const allowed = allowedTools === undefined ? null : new Set(allowedTools);
  const tools = Object.freeze(
    allowed === null ? [...effective.tools] : effective.tools.filter((tool) => allowed.has(tool)),
  );

  return Object.freeze({
    permissions,
    limits,
    engine: effective.engine,
    model: effective.model,
    tools,
  });
}

/** What {@link networkPolicyFloor} resolves a sandbox's network policy to. */
export interface NetworkPolicyFloor {
  readonly networkPolicy: RuntimeNetworkPolicy;
  /** Present only for `restricted`: the profile's own list, or the connector hosts it was lowered to. */
  readonly allowedDomains?: readonly string[];
  /** Whether `open` was lowered because the permission is off. */
  readonly lowered: boolean;
}

/**
 * The sandbox network policy a run gets (ADR-0117 decision 9, issue #785): without
 * `unrestrictedNetwork` a sandbox gets at most `restricted`, so a profile's `open` is lowered to
 * `restricted` with `connectorHosts` (the hosts of the run's remote connectors, which the sandbox
 * itself reaches), or to `none` (the gateway only) when there is none. `none`, `restricted` and a
 * granted `open` are returned unchanged. It never widens. Pure; the result is frozen.
 */
export function networkPolicyFloor(input: {
  readonly networkPolicy: RuntimeNetworkPolicy;
  readonly allowedDomains?: readonly string[] | undefined;
  readonly unrestrictedNetwork: boolean;
  readonly connectorHosts: readonly string[];
}): NetworkPolicyFloor {
  const { networkPolicy, allowedDomains, unrestrictedNetwork, connectorHosts } = input;
  if (networkPolicy !== 'open' || unrestrictedNetwork) {
    return Object.freeze({
      networkPolicy,
      ...(allowedDomains === undefined ? {} : { allowedDomains }),
      lowered: false,
    });
  }
  const hosts = [...new Set(connectorHosts)].sort(byCodeUnit);
  return Object.freeze(
    hosts.length === 0
      ? { networkPolicy: 'none' as const, lowered: true }
      : { networkPolicy: 'restricted' as const, allowedDomains: hosts, lowered: true },
  );
}
