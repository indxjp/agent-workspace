/**
 * The one validation pipeline every version save runs — S1-05 (issue #443), contract C8: a
 * `dryRun` and a save call this same function, so a dry run answers exactly the problems the save
 * would, in the same order, with the same `details`.
 *
 * The steps, in the plan's order, each answering one code of `AGENT_VERSION_PROBLEM_CODES`:
 *
 * 1. **Parse** with `CreateAgentVersionRequestSchema` → `400 invalid_agent_version`, one
 *    `<dotted.path>: <message>` per issue (`(root)` for the body itself). A body whose parse fails
 *    and whose `body.definition.policy.engine` is a string this deployment does not register
 *    answers `400 unsupported_engine` instead, because that names what to fix — the same rule as
 *    `parsePolicyBody` (`../agents/policy.ts`). A body that parses but holds a string (or key)
 *    PostgreSQL cannot store — U+0000, or an unpaired UTF-16 surrogate — answers the same
 *    `400 invalid_agent_version`, one `<dotted.path>: <message>` per string, so a dry run on the
 *    memory store and a save on PostgreSQL refuse it alike, instead of the save failing in the
 *    `jsonb` insert (or a name lookup failing in step 4) as a `500`. An agent name that is blank
 *    once trimmed answers the same code at `<body>.definition.agent.name` (`agents_name_not_blank`
 *    would otherwise fail the materialisation as a `500`).
 * 2. **Engine** registered → `400 unsupported_engine`, `details: [<engine>]`.
 * 3. **Permission mode** not `bypassPermissions` → `400 dangerous_permission_mode_refused`.
 * 4. **Resolution** of every name in this workspace → `422 agent_definition_references_missing`
 *    (`<kind>:<name>` each), else `409 agent_definition_reference_ambiguous`. Missing is reported
 *    before ambiguous, deterministically. C7 (`null`/`'default'` is never missing) is the store's
 *    rule, applied inside `resolveDefinition`.
 *    Then, when the body pins `toolBundles`, every digest must be stored in this workspace →
 *    `422 tool_bundle_unknown` (`tool_bundle:<digest>` each), or `503 tool_bundles_not_configured`
 *    when the deployment keeps no bundles (issue #790).
 *    Then, when the body names `subagents`, each must be an agent of this workspace whose own
 *    materialised version declares none, and the agent being saved must not already be named as a
 *    subagent by another agent (ADR-0133 D14: one level, refused both ways) → `422
 *    agent_subagent_unusable` (`subagent:<name>` each in body order, then `parent:<name>` each,
 *    sorted). The store repeats the check inside the transaction that materialises the version,
 *    which is what closes the race between two concurrent saves. Step 5 is where a usable
 *    subagent is refused until an engine runs them.
 * 5. **Engine capability** → `422 engine_capability_unsupported`, `details: [<capability>]`: `mcp`
 *    for connectors, `skills` for skills, `subagents` for a body that names a subagent (every engine
 *    declares `subagents: false` until subagents run, so none is saved).
 * 6. **Engine switch**, for a stored policy on an existing agent → `422 engine_switch_would_widen`
 *    naming each refused rule; the carried policy is what a save stores (`handlers.ts` writes it
 *    into the version's `definition.policy`, so the immutable body keeps the narrowing whatever
 *    the agent's policy is when the version is later materialised). A compiled policy stores
 *    nothing (`policyToStore: null`). A rule written `mcp__<name>__…` against a workspace MCP
 *    connector's name is stored as `mcp__connector-<id>__…` (ADR-0113 SD13, #1109).
 * 7. **Ceiling**, when the deployment has one (`AW_DEPLOYMENT_POLICY`, issue #535) →
 *    `403 policy_cannot_widen`, `details` the `policyWidenings` in C14 order. It runs after the
 *    switch, so it judges the carried policy: the permissions after its withholding, its limits
 *    and engine (the default arm and no limits when compiled), the explicit model or else the
 *    deployment default for the resolved connection's provider (SD6, no discovery), and the
 *    connector names. It ignores the role. A refusal writes one audit row unless it is a dry run.
 * 8. **The #133 write ceiling** narrows and never refuses: a `read-write` file grant on an agent
 *    whose `writeFiles` is off is accepted here and narrowed to `read` when the store materialises
 *    the version (core's `writeAssignments`, S1-06). The pipeline does not restate that narrowing.
 *
 * {@link validateAgentVersion} is the one function that runs steps 2–7 and the blank-name half of
 * step 1. Each caller parses its own request first ({@link parseVersionRequest}) and hands over the
 * version body:
 *
 * - `POST /api/agents/:id/versions` (S1-05), subject the agent.
 * - `POST /api/agents {version}` (S1-06), subject `{ kind: 'new' }`: the same pipeline before the
 *   agent exists, paths under `version.`.
 * - `PUT /api/agents/:id/pointers` (S1-06): a stored body, re-checked against the agent as it is
 *   now, so a pointer move never materialises what a save would refuse today.
 */
import type { DefinitionReferences, ResolvedReferences } from '@agent-workspace/core/db';
import {
  AGENT_VERSION_PROBLEM_CODES,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentDefinition } from '@indx-workspace/contracts/agents';
import type { z } from 'zod';

import type { AgentPolicy } from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';
import { problem, type ApiResult } from '../agents/handlers';
import {
  carryEngineSwitch,
  connectorNamesOf,
  dangerousPermissionModeRefusal,
  demandsSkills,
  engineCapabilityRefusal,
  mcpRuleServerNames,
  unsupportedEngineRefusal,
  withStoredConnectorIds,
} from '../agents/policy';
import { registeredEngineIds } from '../engines/registry';
import { ceilingStep, type RequestCeiling } from '../policy-ceiling/ceiling';
import type { ToolBundleLookup } from '../tool-bundles/handlers';
import {
  codeToolNeedsHost,
  networkPolicyUnsupported,
  resolutionRefusal,
  subagentNestingRefusal,
} from './problems';
import type { WorkspaceAgentVersionStore } from './store';

/** Whose version this is: an agent that exists, or one S1-06 is about to create. */
export type AgentVersionSubject =
  { readonly kind: 'existing'; readonly agent: AgentRecord } | { readonly kind: 'new' };

/** Where the version body sits in what the client sent. */
type BodyPath = 'body' | 'version.body';

export interface AgentVersionContext {
  readonly subject: AgentVersionSubject;
  /** The dotted path of the body in the request, prefixed to a body-relative problem path. */
  readonly bodyPath: BodyPath;
  /** A dry run writes no step 7 audit row; anything else does. */
  readonly dryRun: boolean;
  /** Resolves the definition's names inside the caller's workspace. */
  readonly store: Pick<
    WorkspaceAgentVersionStore,
    'resolveDefinition' | 'agentsByName' | 'subagentParents' | 'mcpConnectorIdsByName' | 'namesOf'
  >;
  /** The deployment's engine ids; defaults to the installed registry's. */
  readonly registered?: readonly string[];
  /** The deployment's policy ceiling for this request; absent or `null` skips step 7. */
  readonly ceiling?: RequestCeiling | null;
  /** The caller's tool bundles (issue #790); absent or `null` when the deployment keeps none. */
  readonly toolBundles?: ToolBundleLookup | null;
  /**
   * Whether the deployment has a tool sandbox. `false` refuses a body that pins tool bundles
   * (step 3b); absent skips the check, as for a stored body being re-validated.
   */
  readonly toolHost?: boolean;
  /**
   * Why the tool sandbox cannot enforce a code tool's `allowedDomains` (#1018); absent or `null`
   * when it can. With a tool host, a body whose tool declares domains is refused (step 3b).
   */
  readonly toolDomainsRefusal?: string | null;
}

export type ValidatedAgentVersion =
  | {
      readonly ok: true;
      /** Every name resolved to an id in this workspace (a stored body re-resolves to today's). */
      readonly references: ResolvedReferences;
      /** The policy a materialisation stores, carried across an engine switch; `null` if compiled. */
      readonly policyToStore: AgentPolicy | null;
    }
  | { readonly ok: false; readonly result: ApiResult };

/** A plain JSON object: not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `path` inside `raw` when every step of that path is present, else `undefined`. */
function rawEngine(raw: unknown, path: readonly string[]): unknown {
  let current: unknown = raw;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Step 1's refusal: `unsupported_engine` when the unparsed body names an unregistered engine by a
 * string at `enginePath`, otherwise `invalid_agent_version` carrying every parse issue.
 */
function parseRefusal(
  raw: unknown,
  enginePath: readonly string[],
  issues: readonly string[],
  registered: readonly string[],
): ApiResult {
  const engine = rawEngine(raw, enginePath);
  const unsupported =
    typeof engine === 'string' ? unsupportedEngineRefusal(engine, registered, [engine]) : null;
  return (
    unsupported ??
    problem(
      AGENT_VERSION_PROBLEM_CODES.invalid_agent_version,
      'invalid_agent_version',
      'The body is not a version request.',
      issues,
    )
  );
}

/** One `<dotted.path>: <message>` per parse issue, `(root)` for the body itself. */
function issueLines(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
  return issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
}

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether `text` holds U+0000 or a UTF-16 surrogate without its pair. PostgreSQL refuses the first
 * in `text` and in `jsonb` and the second in `jsonb`; the driver silently replaces the second in
 * `text`.
 */
function isUnstorable(text: string): boolean {
  return text.includes('\u0000') || UNPAIRED_SURROGATE.test(text);
}

const UNSTORABLE_MESSAGE =
  'must not contain U+0000 or an unpaired UTF-16 surrogate, which the version store cannot hold';

/**
 * One `<dotted.path>: <message>` per string or object key in `value` that {@link isUnstorable}
 * refuses. Walks a parsed request, whose depth the contract bounds.
 */
function unstorableStringIssues(value: unknown, path: readonly (string | number)[]): string[] {
  const at = (segments: readonly (string | number)[]): string =>
    `${segments.join('.') || '(root)'}: ${UNSTORABLE_MESSAGE}`;
  if (typeof value === 'string') return isUnstorable(value) ? [at(path)] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry: unknown, index) =>
      unstorableStringIssues(entry, [...path, index]),
    );
  }
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(isUnstorable(key) ? [at([...path, key])] : []),
    ...unstorableStringIssues(entry, [...path, key]),
  ]);
}

/** A parsed request holding a string the version store cannot hold. */
function unstorableRefusal(request: unknown): ApiResult | null {
  const unstorable = unstorableStringIssues(request, []);
  if (unstorable.length === 0) return null;
  return problem(
    AGENT_VERSION_PROBLEM_CODES.invalid_agent_version,
    'invalid_agent_version',
    'The body is not a version request.',
    unstorable,
  );
}

/** Where a definition keeps the agent's name, below the body. */
const AGENT_NAME_PATH = 'definition.agent.name';

/**
 * Step 1's last half: an agent name that is blank once trimmed. The contract bounds the name's
 * length but not its content, and `agents` carries `CHECK (length(btrim(name)) > 0)`, so without
 * this a dry run answered `200` for a body whose save — or whose later pointer move — failed in
 * the insert or update as a `500`. JavaScript's `trim` strips every whitespace character, not only
 * the spaces `btrim` strips, so a tab-only name is refused too: it is as blank to a reader. The
 * legacy routes refuse the same names (`parseAgentName`).
 */
function blankNameRefusal(definition: AgentDefinition, bodyPath: BodyPath): ApiResult | null {
  if (definition.agent.name.trim().length > 0) return null;
  return problem(
    AGENT_VERSION_PROBLEM_CODES.invalid_agent_version,
    'invalid_agent_version',
    'The body is not a version request.',
    [`${bodyPath}.${AGENT_NAME_PATH}: must not be blank`],
  );
}

/** The references a definition names, in the shape `resolveDefinition` takes. */
export function definitionReferences(definition: AgentDefinition): DefinitionReferences {
  return {
    modelConnectionName: definition.agent.modelConnectionName,
    runtimeProfileName: definition.agent.runtimeProfileName,
    skills: definition.resources.skills,
    connectors: definition.resources.connectors,
    files: definition.resources.files,
  };
}

/**
 * Step 4's second half: `422 tool_bundle_unknown` naming each pinned digest this workspace has no
 * bundle for (`tool_bundle:<digest>`), or `503` when the body pins bundles and the deployment has
 * nowhere to keep them. A body that pins none never reaches the store.
 */
async function toolBundleRefusal(
  body: AgentVersionBody,
  lookup: ToolBundleLookup | null,
): Promise<ApiResult | null> {
  const digests = (body.toolBundles ?? []).map((bundle) => bundle.digest);
  if (digests.length === 0) return null;
  if (lookup === null) {
    return problem(
      AGENT_VERSION_PROBLEM_CODES.tool_bundles_not_configured,
      'tool_bundles_not_configured',
      'Tool bundles are not configured for this deployment.',
    );
  }
  const missing = await lookup(digests);
  if (missing.length === 0) return null;
  return problem(
    AGENT_VERSION_PROBLEM_CODES.tool_bundle_unknown,
    'tool_bundle_unknown',
    'The version pins tool bundles this workspace has not uploaded.',
    missing.map((digest) => `tool_bundle:${digest}`),
  );
}

/**
 * Step 4's third part: `422 agent_subagent_unusable` for a body that names subagents, both ways
 * (`subagentNestingRefusal`): each named agent must exist here, declare no subagents and have a description, and the
 * agent being saved (by the body's name, excluding the subject's own id) must not already be
 * named as one. A body that names none never reaches the store.
 */
async function subagentRefusal(
  body: AgentVersionBody,
  subject: AgentVersionSubject,
  store: Pick<WorkspaceAgentVersionStore, 'agentsByName' | 'subagentParents'>,
): Promise<ApiResult | null> {
  const names = (body.subagents ?? []).map((subagent) => subagent.name);
  if (names.length === 0) return null;
  const found = await store.agentsByName(names);
  const unusable = names.filter((name) => {
    const candidate = found.get(name);
    return candidate === undefined || candidate.hasSubagents || !candidate.hasDescription;
  });
  const parents = await store.subagentParents(
    body.definition.agent.name,
    subject.kind === 'existing' ? subject.agent.id : null,
  );
  if (unusable.length === 0 && parents.length === 0) return null;
  return subagentNestingRefusal(unusable, parents);
}

/**
 * Step 1 for a request that carries a version body at `bodyPath`: parse with `schema`, answer
 * `unsupported_engine` when the parse fails on an unregistered engine string, and refuse any string
 * the version store cannot hold (the whole request, so `summary` too).
 */
export function parseVersionRequest<Request>(
  schema: z.ZodType<Request>,
  raw: unknown,
  bodyPath: BodyPath,
  registered: readonly string[] = registeredEngineIds(),
):
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly result: ApiResult } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const enginePath = [...bodyPath.split('.'), 'definition', 'policy', 'engine'];
    const issues = issueLines(parsed.error.issues);
    return { ok: false, result: parseRefusal(raw, enginePath, issues, registered) };
  }
  const unstorable = unstorableRefusal(parsed.data);
  if (unstorable !== null) return { ok: false, result: unstorable };
  return { ok: true, request: parsed.data };
}

/**
 * Run the pipeline over a parsed version body. Pure apart from `store.resolveDefinition` and the
 * ceiling's lookups, which only read, and a step 7 refusal's audit row, written only when this is
 * not a dry run: nothing else writes, so a dry run is this function and no more.
 */
export async function validateAgentVersion(
  body: AgentVersionBody,
  context: AgentVersionContext,
): Promise<ValidatedAgentVersion> {
  const { definition } = body;
  const { policy } = definition;
  const { subject } = context;
  const registered = context.registered ?? registeredEngineIds();

  // 1, last half: a blank name (a stored version may predate this check).
  const blank = blankNameRefusal(definition, context.bodyPath);
  if (blank !== null) return { ok: false, result: blank };

  // 2. Engine.
  const unsupported = unsupportedEngineRefusal(policy.engine, registered, [policy.engine]);
  if (unsupported !== null) return { ok: false, result: unsupported };

  // 3. Permission mode.
  const dangerous = dangerousPermissionModeRefusal(policy);
  if (dangerous !== null) return { ok: false, result: dangerous };

  // 3b. Code tools need a tool sandbox (ADR-0118 TS8). Before resolution, so a deployment without
  // one answers by name instead of `references_missing [connector:aw-dev-tools]`.
  const toolBundles = body.toolBundles ?? [];
  if (context.toolHost === false && toolBundles.length > 0) {
    const tools = toolBundles.map((bundle) => bundle.tool);
    return { ok: false, result: codeToolNeedsHost(null, 'no-tool-host', tools) };
  }
  // A tool host that cannot enforce `allowedDomains` (E2B, ADR-0120 LC4) would fail every run of the
  // agent at allocation; refuse the tools that declare them here, never run them with open egress.
  if (context.toolHost === true && typeof context.toolDomainsRefusal === 'string') {
    const tools = toolBundles
      .filter((bundle) => (bundle.allowedDomains?.length ?? 0) > 0)
      .map((bundle) => bundle.tool);
    if (tools.length > 0) {
      return { ok: false, result: networkPolicyUnsupported(tools, context.toolDomainsRefusal) };
    }
  }

  // 4. Resolution (C7 is the store's).
  const resolution = await context.store.resolveDefinition(definitionReferences(definition));
  if (resolution.kind === 'unresolved') return { ok: false, result: resolutionRefusal(resolution) };

  // 4b. Pinned tool bundles (issue #790): every digest the body names is stored in this workspace.
  const unpinned = await toolBundleRefusal(body, context.toolBundles ?? null);
  if (unpinned !== null) return { ok: false, result: unpinned };

  // 4c. Subagents (ADR-0133 D14): each exists here and declares none of its own.
  const unusable = await subagentRefusal(body, subject, context.store);
  if (unusable !== null) return { ok: false, result: unusable };

  // 5. Engine capability. A compiled policy demands every assigned skill, as a NULL column does.
  const stored = definition.policySource === 'stored';
  const capability = engineCapabilityRefusal(policy.engine, {
    connectors: definition.resources.connectors.length > 0,
    skills: demandsSkills(stored ? policy : null, new Set(definition.resources.skills)),
    subagents: (body.subagents?.length ?? 0) > 0,
  });
  if (capability !== null) return { ok: false, result: capability };

  // 6. Engine switch: carry the stored arm's narrowing into a stored policy, or refuse.
  let policyToStore: AgentPolicy | null = null;
  if (stored) {
    const current = subject.kind === 'existing' ? subject.agent.policy : null;
    let carried = carryEngineSwitch(current, policy);
    // The names only label a refusal's message, so they are read only for one.
    if (!carried.ok && current !== null) {
      carried = carryEngineSwitch(current, policy, await connectorNamesOf(context.store, current));
    }
    if (!carried.ok) return { ok: false, result: carried.result };
    // ADR-0113 SD13 (#1109): a rule written against an MCP connector's name is stored by its id.
    const names = mcpRuleServerNames(carried.policy);
    policyToStore =
      names.length === 0
        ? carried.policy
        : withStoredConnectorIds(carried.policy, await context.store.mcpConnectorIdsByName(names));
  }

  // 7. Ceiling, over what a materialisation would leave (the carried policy).
  const refused = await ceilingStep(
    {
      permissions: definition.agent.permissions,
      policy: policyToStore,
      model: definition.agent.model,
      modelConnectionId: resolution.references.modelConnectionId,
    },
    definition.resources.connectors,
    context.ceiling,
    context.dryRun
      ? null
      : { id: subject.kind === 'existing' ? subject.agent.id : null, label: definition.agent.name },
  );
  if (refused !== null) return { ok: false, result: refused };

  // 8. The #133 write ceiling narrows at materialisation and never refuses: nothing to do here.
  return { ok: true, references: resolution.references, policyToStore };
}
