import { AGENT_DEFINITION_PROBLEM_CODES, AGENT_POLICY_PROBLEM_CODES } from '../agents.js';
import { TOOL_BUNDLE_PROBLEM_CODES } from './tool-bundles.js';
import { RUN_START_PROBLEM_CODES } from '../runs.js';
import { STORAGE_CONNECTION_PROBLEM_CODES } from '../storage-connections.js';

/**
 * Problem codes the version routes (S1-05, S1-06) answer, with the status each travels under
 * (ADR-0101, ADR-0108; issue #440). A code another table already owns keeps that table's status,
 * read from it rather than retyped. RBAC's `forbidden` stays in `COMMON_PROBLEM_CODES`.
 */
export const AGENT_VERSION_PROBLEM_CODES = {
  /** The agent id in the route's path is not a UUID — what every `/api/agents/:id` route answers. */
  invalid_agent_id: 400,
  /**
   * The body is not a version request; each `details` entry is one parse issue,
   * `<dotted.path>: <message>` (`(root)` for the body itself).
   */
  invalid_agent_version: 400,
  /** The definition's policy names an engine this deployment does not register. */
  unsupported_engine: AGENT_POLICY_PROBLEM_CODES.unsupported_engine,
  /** The definition's policy asks for `permissionMode: 'bypassPermissions'`. */
  dangerous_permission_mode_refused: AGENT_POLICY_PROBLEM_CODES.dangerous_permission_mode_refused,
  /** The agent the route names does not exist in this workspace. */
  agent_not_found: AGENT_POLICY_PROBLEM_CODES.agent_not_found,
  /** This deployment has no policy store, so a definition's policy cannot be checked or saved. */
  agent_policy_not_configured: AGENT_POLICY_PROBLEM_CODES.agent_policy_not_configured,
  /**
   * The version number the request names does not exist; `details` is `[version:<n>]`. The release
   * model's `version_not_found` (issue #615).
   */
  agent_version_not_found: 404,
  /**
   * The agent is archived, so no version is saved and no pointer moves until it is restored
   * (#1851). The run refusal's code and status, so the two cannot drift.
   */
  agent_archived: RUN_START_PROBLEM_CODES.agent_archived,
  /** Another save took the version number an in-process create named; start over (#1848). */
  agent_version_number_taken: 409,
  /** A promote's source, `local`, points at no version, so there is nothing to promote (#615). */
  no_pointer: 409,
  /** A rollback's environment has no history entry before its pointer (issue #615). */
  nothing_to_roll_back: 409,
  /**
   * A pointer move's `expectedVersion` is not what the environment points at now (#1847); `details`
   * is `[environment:<environment>, current:<n|none>]`. Read the agent again and decide anew.
   */
  pointer_moved: 409,
  /**
   * The deployment's policy sets a promotion bar, and the version has no evaluation; `details` is
   * `[version:<n>, bar:<bar>]` (issue #619).
   */
  promotion_not_evaluated: 409,
  /**
   * The version's latest evaluation passed less than the bar's share of its cases; `details` is
   * `[version:<n>, score:<score>, bar:<bar>, case:<name>…]`, the failing cases in order (#619).
   */
  promotion_gate_failed: 409,
  /**
   * The version lists the local tool host's connector (`AW_DEV_TOOLS_CONNECTOR`), so it
   * runs code tools that only `aw dev` serves, and an environment other than `local` cannot run
   * them (ADR-0115); `details` is `[connector:aw-dev-tools, environment:<environment>]`.
   */
  code_tool_needs_host: 422,
  /**
   * A code tool in the version declares `allowedDomains`, which the deployment's tool sandbox
   * cannot enforce (ADR-0120 LC4, issue #1018); `details` is `[tool:<name>…]`, the tools in body
   * order. Remove the domains or deploy where the tool sandbox enforces them.
   */
  network_policy_unsupported: 422,
  /**
   * The version lists a `stdio` MCP connector, which runs only in a per-session tool sandbox
   * (ADR-0118 TS6) or as a local child under `aw dev`, and no environment other than `local`
   * can start a tool sandbox yet; `details` is `[connector:<name>…, environment:<environment>]`,
   * the connectors in body order.
   */
  stdio_connector_needs_tool_sandbox: 422,
  /**
   * The version pins a code-tool bundle this workspace does not hold (issue #790); `details` is
   * `[tool_bundle:<digest>]` for each such digest, in body order. Upload the bundle first
   * (`POST /api/tool-bundles`).
   */
  tool_bundle_unknown: 422,
  /** This deployment has no store for tool bundles, so a version that pins one cannot be checked. */
  tool_bundles_not_configured: TOOL_BUNDLE_PROBLEM_CODES.tool_bundles_not_configured,
  /** Names in the definition do not exist here; each `details` entry is `<kind>:<name>`. */
  agent_definition_references_missing:
    AGENT_DEFINITION_PROBLEM_CODES.agent_definition_references_missing,
  /** A name in the definition matches more than one resource; each entry is `<kind>:<name>`. */
  agent_definition_reference_ambiguous:
    AGENT_DEFINITION_PROBLEM_CODES.agent_definition_reference_ambiguous,
  /** The engine cannot honour an assigned connector or skill; `details` is the capability. */
  engine_capability_unsupported: AGENT_POLICY_PROBLEM_CODES.engine_capability_unsupported,
  /**
   * The version would nest subagents (ADR-0133 D14: one level, refused both ways). A subagent it
   * names cannot be used: no agent of that name in this workspace, or that agent itself declares
   * subagents. Or the agent being saved is already another agent's subagent, so it may not declare
   * any. `details` is `subagent:<name>` per unusable subagent, in body order, then `parent:<name>`
   * per agent that names this one, sorted.
   */
  agent_subagent_unusable: 422,
  /** The version changes the engine in a way that would widen the agent; each entry is the item. */
  engine_switch_would_widen: AGENT_POLICY_PROBLEM_CODES.engine_switch_would_widen,
  /**
   * The version asks for more than the deployment's policy ceiling allows (C14, ADR-0102 SD6,
   * issue #524); `details` are the C14 widenings. Answered whatever the caller's role.
   */
  policy_cannot_widen: AGENT_POLICY_PROBLEM_CODES.policy_cannot_widen,
  /**
   * A pointer move or a create-from-version would give the workspace two surfaces of one name
   * (C9); `details` is `[surface:<name>]` for each such name.
   */
  surface_name_taken: 409,
  /**
   * The agent name the version defines is already another agent's in this workspace
   * (create-from-version; a pointer move that renames the agent) — the same unique key and status
   * legacy `POST`/`PATCH /api/agents` answer. No `details` (issue #480; S1-09, issue #447).
   */
  agent_name_conflict: 409,
  /** An assigned file is not in this workspace; `details` is `[<id>]` (resource assignments). */
  unknown_file: 400,
  /** An assigned skill is not in this workspace; `details` is `[<id>]`. */
  unknown_skill: 400,
  /** An assigned skill is being deleted and cannot be assigned any more; `details` is `[<id>]`. */
  skill_deleting: 409,
  /** An assigned connector is not in this workspace; `details` is `[<id>]`. */
  unknown_connector: 400,
  /**
   * A `storage://<connection>/<folder>` grant names a folder outside the connection's allowed
   * folders; `details` are the refused paths in body order (the storage design, §05).
   */
  storage_connection_prefix_not_allowed:
    STORAGE_CONNECTION_PROBLEM_CODES.storage_connection_prefix_not_allowed,
  /** A `read-write` storage grant names a connection that is read-only; `details` as above. */
  storage_connection_write_not_allowed:
    STORAGE_CONNECTION_PROBLEM_CODES.storage_connection_write_not_allowed,
} as const;
export type AgentVersionProblemCode = keyof typeof AGENT_VERSION_PROBLEM_CODES;
