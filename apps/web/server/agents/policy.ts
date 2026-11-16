/**
 * S-13: compile-or-read, validate and serialize an agent's policy — the logic behind
 * `GET`/`PUT /api/agents/:id/policy`, kept apart from `Request`/`Response` the way `handlers.ts`
 * keeps the other five agent operations apart from them.
 *
 * ## `GET`: the stored policy, or the compiled one
 *
 * `agent.policy` is `null` for every agent until a `PUT` writes one — see
 * `packages/core/src/db/schema/agents.ts`'s `AgentStoredPolicy`. A `null` column reads as the
 * *compiled* policy: the same `tools` the engine's adapter derives from the four permission
 * booleans, an allowlist of the agent's currently assigned and enabled skills, and no limit.
 * {@link compiledPolicyFor} is built from `packages/contracts`' `claudeBaseToolPolicyFor` — the
 * *same function* the adapter compiles from, not a re-derivation of it — so the two cannot drift.
 *
 * ## `PUT`: strictly narrowing, and only onto what is assigned
 *
 * A `PUT` may restrict an agent past its permission checkboxes but never widen it past them — the
 * engine's adapter (`packages/engine-claude-agent-sdk/src/tools.ts`) unions the permission-derived
 * and file-grant denials into whatever `tools.deny` this module stores, rather than replacing them,
 * so the narrowing is enforced at compile time as well as here. This module's own refusals are the
 * ones the wire contract cannot express by itself: an `engine` this deployment does not register
 * (`400 unsupported_engine` — the contracts publish the catalogue, but which of it a deployment
 * installs is {@link ../engines/registry.ts}'s answer), the pre-ADR-0065 `provider` discriminant
 * (`400 invalid_body`), an engine that is registered but cannot honour a connector or a skill this agent is assigned
 * (`422 engine_capability_unsupported` — ADR-0065 D3's "refuse, never ignore"; see
 * {@link engineCapabilityRefusal}), a `skills.mode: 'allowlist'` naming a
 * skill this agent has no assignment for (`409 skill_not_assigned` — assignment, not enablement,
 * is what is checked, since `PATCH /api/skills/:name` can re-enable a skill without touching the
 * assignment), and a parseable `permissionMode: 'bypassPermissions'` (`400
 * dangerous_permission_mode_refused` — R-01 §10 makes it the one mode requiring a dangerous flag,
 * and nothing on the site offers it as an authoring choice; see the implementation plan's open
 * question 6).
 *
 * ## Shell and core (refactoring plan part 07)
 *
 * The rules themselves are pure and live in `./core/policy.ts`, which answers a refusal as data.
 * This file is the shell: it loads the assignments and the catalog, reads the engine registry, and
 * turns a core refusal into the route's problem answer. The pure rules are re-exported here under
 * their old names, so every caller keeps its import.
 *
 * ## An engine switch carries the narrowing across (ADR-0074 D12)
 *
 * A `PUT` that changes `engine` is translated against the stored arm by the contracts'
 * `translatePolicyForEngineSwitch` before anything else is decided: whatever the old arm withheld
 * — a `tools.deny` rule, a `base` list, a narrowing `permissionMode` — is written into the new
 * arm, and a denial the new arm cannot express is refused `422 engine_switch_would_widen`, naming
 * each rule. See {@link carryEngineSwitch}.
 */
import { connectorServerKey } from '@indx-workspace/contracts/tool-connectors';

import { AGENT_POLICY_PROBLEM_CODES, type AgentPolicy } from '../../contracts/agents';
import {
  type EngineCapabilityDemand,
  engineCapabilityRefusalMessage,
  registeredEngine,
  registeredEngineIds,
  unsupportedEngineCapability,
} from '../execution';
import { formatIssues, problem, type ApiResult } from '../http/result';
import {
  carryEngineSwitch as carryEngineSwitchRule,
  CONNECTOR_SERVER_PREFIX,
  dangerousPermissionMode,
  parsePolicy,
  storedConnectorServers,
  unsupportedEngine,
  type AssignedResourceIds,
  type PolicyRefusal,
} from './core/policy';
import type { AgentResourceStoreProvider } from './resource-store';
import type { ResourceCatalogStoreProvider } from '../storage-and-sharing';

export {
  compiledPolicyFor,
  demandsConnectors,
  demandsSkills,
  firstUnassignedSkillName,
  mcpRuleServerNames,
  policyFor,
  policySourceOf,
  storedConnectorServers,
  withStoredConnectorIds,
} from './core/policy';

/** A core refusal as the route answers it. */
function refusalResult(refusal: PolicyRefusal): ApiResult {
  const details =
    refusal.details ?? (refusal.issues === undefined ? undefined : formatIssues(refusal.issues));
  return problem(refusal.status, refusal.code, refusal.message, details);
}

/**
 * Every catalog skill an agent's assignment row names, by name — regardless of whether it is
 * currently enabled. Assignment, not enablement, is the membership a `PUT` is checked against (see
 * the file header); enablement narrows what `compiledPolicyFor` lists for a `GET`.
 *
 * It takes the row rather than reading it, so a caller that also asks `demandsConnectors`
 * decides both against one read of the assignments, not two that a concurrent
 * `PUT /api/agents/:id/resources` could land between.
 */
export async function assignedSkillNames(
  workspaceId: string,
  assigned: Pick<AssignedResourceIds, 'skillIds'> | null,
  catalog: ResourceCatalogStoreProvider,
): Promise<ReadonlySet<string>> {
  if (assigned === null || assigned.skillIds.length === 0) return new Set();
  const rows = await (await catalog.forWorkspace(workspaceId)).listSkills();
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  const names = new Set<string>();
  for (const id of assigned.skillIds) {
    const name = byId.get(id);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** The same, but only the assigned skills that are also enabled — what `compiledPolicyFor` lists. */
export async function assignedEnabledSkillNames(
  workspaceId: string,
  agentId: string,
  assignments: AgentResourceStoreProvider,
  catalog: ResourceCatalogStoreProvider,
): Promise<readonly string[]> {
  const assigned = await assignments.forWorkspace(workspaceId).get(agentId);
  if (assigned === null || assigned.skillIds.length === 0) return [];
  const rows = await (await catalog.forWorkspace(workspaceId)).listSkills();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const names: string[] = [];
  for (const id of assigned.skillIds) {
    const row = byId.get(id);
    if (row !== undefined && row.enabled) names.push(row.name);
  }
  return names;
}

export type ParsedPolicyBody =
  | { readonly ok: true; readonly policy: AgentPolicy }
  | { readonly ok: false; readonly result: ApiResult };

/**
 * Parse a `PUT` body against `AgentPolicySchema`, refusing a dangerous permission mode
 * before anything is stored (the rules: `parsePolicy` in `./core/policy.ts`).
 *
 * Three refusals are told apart from the generic shape failure, because each names a different
 * thing the client can fix:
 *
 *   * `invalid_body` — the body carries the pre-ADR-0065 `provider` discriminant. `provider` means
 *     the *model* provider everywhere else on the wire, so it is refused by name rather than
 *     reported as "`engine` is missing", and never read as the new shape.
 *   * `unsupported_engine` — the body names an engine this deployment does not register. Fixable by
 *     naming one it does; `invalid_policy` would hide that behind a zod enum complaint.
 *   * `dangerous_permission_mode_refused` — see the file header.
 *
 * `registered` is the deployment's engine ids, defaulting to the installed registry's. It is a
 * parameter so the refusal can be proven against an engine that is *not* installed — while
 * `claude-agent-sdk` is the only engine the contracts publish, no body could otherwise reach the
 * second branch with a parseable `engine`.
 */
export function parsePolicyBody(
  raw: unknown,
  registered: readonly string[] = registeredEngineIds(),
): ParsedPolicyBody {
  const parsed = parsePolicy(raw, registered);
  return parsed.ok ? parsed : { ok: false, result: refusalResult(parsed.refusal) };
}

/**
 * `400 unsupported_engine` when `engine` is not one of the `registered` engine ids, otherwise
 * `null`. One implementation shared by {@link parsePolicyBody} and the version pipeline
 * (`../agent-versions/pipeline.ts`, S1-05), so the policy route and a saved version refuse an
 * engine with the same code and message. `engine` is whatever the body carried, unparsed.
 *
 * `details` is passed through: the policy route has never sent any, and the version contract
 * documents `[<engine>]` (`AGENT_VERSION_PROBLEM_CODES.unsupported_engine`), so each caller keeps
 * its own published shape.
 */
export function unsupportedEngineRefusal(
  engine: unknown,
  registered: readonly string[],
  details?: readonly string[],
): ApiResult | null {
  const refusal = unsupportedEngine(engine, registered, details);
  return refusal === null ? null : refusalResult(refusal);
}

/**
 * `400 dangerous_permission_mode_refused` when a parsed policy asks for
 * `permissionMode: 'bypassPermissions'` (see the file header), otherwise `null`. Shared by
 * {@link parsePolicyBody} and the version pipeline (S1-05).
 */
export function dangerousPermissionModeRefusal(policy: AgentPolicy): ApiResult | null {
  const refusal = dangerousPermissionMode(policy);
  return refusal === null ? null : refusalResult(refusal);
}

/**
 * `422 engine_capability_unsupported` when `engineId` cannot honour `demand`, otherwise `null`
 * (ADR-0065 D3 — refuse, never ignore).
 *
 * An engine this deployment does not register answers `null`: whether an engine may be *named* is
 * {@link parsePolicyBody}'s question and it has already answered `unsupported_engine` for that body,
 * so reporting a missing capability of an engine that is not installed would name the wrong fix.
 * The refusal's `details` is exactly the capability, which is what a client branches on
 * (`ENGINE_CAPABILITY_KEYS`, `packages/contracts/src/engines.ts`).
 */
export function engineCapabilityRefusal(
  engineId: string,
  demand: EngineCapabilityDemand,
): ApiResult | null {
  const engine = registeredEngine(engineId);
  if (engine === null) return null;
  const capability = unsupportedEngineCapability(engine.capabilities, demand);
  if (capability === null) return null;
  return problem(
    AGENT_POLICY_PROBLEM_CODES.engine_capability_unsupported,
    'engine_capability_unsupported',
    engineCapabilityRefusalMessage(engineId, capability),
    [capability],
  );
}

/**
 * The current key ({@link connectorServerKey}) of each connector a rule of `policy` stores by id,
 * keyed by `connector-<id>` (display only, see {@link describeToolRule}). A connector the workspace
 * no longer has, or whose key falls back to `connector-<id>`, is absent, and a policy with no such
 * rule asks the store nothing.
 */
export async function connectorNamesOf(
  store: {
    namesOf(ids: {
      connector: readonly string[];
    }): Promise<{ connector: ReadonlyMap<string, string> }>;
  },
  policy: AgentPolicy,
): Promise<Record<string, string>> {
  const servers = storedConnectorServers(policy);
  if (servers.length === 0) return {};
  const { connector } = await store.namesOf({
    connector: servers.map((server) => server.slice(CONNECTOR_SERVER_PREFIX.length)),
  });
  const names: Record<string, string> = {};
  for (const [id, name] of connector) {
    // The run's tool connector keys are unknown here, so none is taken.
    const key = connectorServerKey(name, id, new Set());
    const server = `${CONNECTOR_SERVER_PREFIX}${id}`;
    if (key !== server) names[server] = key;
  }
  return names;
}

export type CarriedPolicy =
  | { readonly ok: true; readonly policy: AgentPolicy }
  | { readonly ok: false; readonly result: ApiResult };

/**
 * Carry the stored policy's narrowing into a `PUT` that switches engines (ADR-0074 D12), or refuse
 * `422 engine_switch_would_widen` naming every denial the new arm cannot express.
 *
 * `stored` is the column: `null` means no policy was ever stored, and the compiled policy a `GET`
 * would answer narrows nothing beyond the permission checkboxes, which every engine compiles from
 * already — so there is nothing to carry. A `PUT` on the same engine is a replacement, carried
 * verbatim: that is how an owner widens on purpose.
 */
export function carryEngineSwitch(
  stored: AgentPolicy | null,
  next: AgentPolicy,
  connectorNames: Readonly<Record<string, string>> = {},
): CarriedPolicy {
  const carried = carryEngineSwitchRule(stored, next, connectorNames);
  return carried.ok ? carried : { ok: false, result: refusalResult(carried.refusal) };
}
