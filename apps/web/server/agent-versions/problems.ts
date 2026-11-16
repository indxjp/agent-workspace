/**
 * The refusals and the one retry rule the S1-06 write paths share (issue #444): the pointer moves
 * (`pointers.ts`, with promote and rollback since #615) and the create-from-version
 * (`create-from-version.ts`) answer these the same way, so they are stated once.
 */
import type {
  ResolveDefinitionOutcome,
  ResolvedReferences,
  WorkspaceAgentVersionStore,
} from './store';
import { BUILDER_REFUSAL_CODES } from '@indx-workspace/contracts/builder';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import {
  AGENT_VERSION_PROBLEM_CODES,
  type AgentVersionProblemCode,
} from '@indx-workspace/contracts/agent-versions';

import type { AgentRecord } from '../agents/contract';
import { problem, type ApiResult } from '../http/result';

/**
 * A problem whose status is read from the contract's code table, so no refusal here restates a
 * status and a misspelt code fails to compile.
 */
function versionProblem(
  code: AgentVersionProblemCode,
  message: string,
  details?: readonly string[],
): ApiResult {
  return problem(AGENT_VERSION_PROBLEM_CODES[code], code, message, details);
}

/**
 * Step 4's refusal for a definition whose names did not all resolve: missing before ambiguous,
 * deterministically. Exported for the S1-06 handlers' `reference-gone` retry, which re-resolves
 * once and answers this same refusal when a name went away after the pipeline ran.
 */
export function resolutionRefusal(
  resolution: Extract<ResolveDefinitionOutcome, { readonly kind: 'unresolved' }>,
): ApiResult {
  if (resolution.missing.length > 0) {
    return problem(
      AGENT_VERSION_PROBLEM_CODES.agent_definition_references_missing,
      'agent_definition_references_missing',
      'The definition names resources this workspace does not have.',
      resolution.missing.map((reference) => `${reference.kind}:${reference.name}`),
    );
  }
  // A skill being deleted is a conflict with its state, as for `PUT /api/agents/:id/skills`.
  if (resolution.deleting !== undefined && resolution.deleting.length > 0) {
    return versionProblem(
      'skill_deleting',
      'An assigned skill is being deleted.',
      resolution.deleting.map((reference) => reference.name),
    );
  }
  return problem(
    AGENT_VERSION_PROBLEM_CODES.agent_definition_reference_ambiguous,
    'agent_definition_reference_ambiguous',
    'The definition names resources that match more than one in this workspace; rename one.',
    resolution.ambiguous.map((reference) => `${reference.kind}:${reference.name}`),
  );
}

/**
 * `422 agent_subagent_unusable`: the subagents a version names that no agent of this workspace
 * carries, that have subagents themselves or that have no description (`subagent:<name>`, body order), then the agents that
 * already name this one as a subagent (`parent:<name>`, sorted). The pipeline and the store's
 * in-transaction check answer this one refusal.
 */
export function subagentNestingRefusal(
  unusable: readonly string[],
  parents: readonly string[],
): ApiResult {
  return versionProblem(
    'agent_subagent_unusable',
    'The version nests subagents: a subagent must exist here, have a description and have no subagents of its own, and an agent that is a subagent cannot have any.',
    [...unusable.map((name) => `subagent:${name}`), ...parents.map((name) => `parent:${name}`)],
  );
}

/** `404 agent_version_not_found`, naming the number the client asked for. */
export function agentVersionNotFound(number: number): ApiResult {
  return versionProblem('agent_version_not_found', 'The agent has no version with that number.', [
    `version:${String(number)}`,
  ]);
}

/** `409 no_pointer`: a promote with no version given, while `local` points at none (#615). */
export function noPointer(): ApiResult {
  return versionProblem('no_pointer', 'The local environment points at no version to promote.');
}

/**
 * `409 promotion_not_evaluated`: the deployment sets a promotion bar and version `number` has no
 * evaluation (issue #619).
 */
export function promotionNotEvaluated(number: number, bar: number): ApiResult {
  return versionProblem(
    'promotion_not_evaluated',
    'The version has no evaluation, and production needs one that reaches the promotion bar.',
    [`version:${String(number)}`, `bar:${String(bar)}`],
  );
}

/**
 * `409 promotion_gate_failed`: version `number`'s newest evaluation passed less than the bar's
 * share of its cases; `details` names its score, the bar and each failing case (issue #619).
 */
export function promotionGateFailed(refusal: {
  readonly version: number;
  readonly score: number;
  readonly bar: number;
  readonly failing: readonly string[];
}): ApiResult {
  return versionProblem(
    'promotion_gate_failed',
    "The version's newest evaluation is below the promotion bar.",
    [
      `version:${String(refusal.version)}`,
      `score:${String(refusal.score)}`,
      `bar:${String(refusal.bar)}`,
      ...refusal.failing.map((name) => `case:${name}`),
    ],
  );
}

/**
 * `422 code_tool_needs_host`: the version lists the tool host's connector, and `environment` cannot
 * run its code tools: the deployment has no tool sandbox, or the version pins no bundle one can
 * serve (issue #693, ADR-0118 TS8). The details are the same either way; the message names why.
 * `tools` names the refused code tools, when the caller knows them.
 */
export function codeToolNeedsHost(
  environment: string | null,
  reason: 'no-tool-host' | 'unbundled',
  tools: readonly string[] = [],
): ApiResult {
  const why =
    reason === 'no-tool-host'
      ? 'this deployment has no tool sandbox (the operator enables it with AGENT_WORKSPACE_TOOL_HOST_IMAGE on the web and the runner)'
      : 'the version pins no hostable bundle for its code tools (push it again with aw push)';
  return versionProblem(
    'code_tool_needs_host',
    `The version uses code tools, so ${environment ?? 'this deployment'} cannot run it: ${why}.`,
    [
      `connector:${AW_DEV_TOOLS_CONNECTOR}`,
      ...(environment === null ? [] : [`environment:${environment}`]),
      ...tools.map((tool) => `tool:${tool}`),
    ],
  );
}

/**
 * `422 network_policy_unsupported`: the code tools `tools` declare `allowedDomains`, and the
 * deployment's tool sandbox cannot enforce them (`reason`, from `restrictedUnenforceableReason`).
 * Refused at the version, since every run of the agent would otherwise fail at allocation (#1018).
 */
export function networkPolicyUnsupported(tools: readonly string[], reason: string): ApiResult {
  return versionProblem(
    'network_policy_unsupported',
    `The code ${tools.length === 1 ? 'tool' : 'tools'} ${tools.join(', ')} ${tools.length === 1 ? 'declares' : 'declare'} allowedDomains, which this deployment's tool sandbox cannot enforce: ${reason}.`,
    tools.map((tool) => `tool:${tool}`),
  );
}

/**
 * `422 stdio_connector_needs_tool_sandbox`: the version lists `stdio` MCP connectors, which launch
 * only in a per-session tool sandbox (ADR-0118 TS6), and no deployment environment starts one for
 * them yet, so `environment` cannot run it. Each connector is named (issue #793).
 */
export function stdioConnectorNeedsToolSandbox(
  environment: string,
  connectors: readonly string[],
): ApiResult {
  return versionProblem(
    'stdio_connector_needs_tool_sandbox',
    `The version uses stdio connectors (${connectors.join(', ')}) that run only in a tool sandbox, which ${environment} does not start for them, so it cannot run this version.`,
    [...connectors.map((name) => `connector:${name}`), `environment:${environment}`],
  );
}

/** `409 nothing_to_roll_back`: `environment` has no history entry before its pointer (#615). */
export function nothingToRollBack(environment: string): ApiResult {
  return versionProblem(
    'nothing_to_roll_back',
    'The environment has no earlier version to roll back to.',
    [`environment:${environment}`],
  );
}

/**
 * `409 pointer_moved` (#1847): a move's `expectedVersion` is not what `environment` points at now.
 * `details` carries only this agent's current version number, `none` when it points at none.
 */
export function pointerMoved(environment: string, current: number | null): ApiResult {
  return versionProblem(
    'pointer_moved',
    'The environment no longer points at the version the move expected.',
    [`environment:${environment}`, `current:${current === null ? 'none' : String(current)}`],
  );
}

/** `409 surface_name_taken` (C9), naming the surface another pointed version already serves. */
export function surfaceNameTaken(name: string): ApiResult {
  return versionProblem(
    'surface_name_taken',
    'Another agent in this workspace already serves a surface of that name in this environment.',
    [`surface:${name}`],
  );
}

/**
 * `409 agent_name_conflict` — the status comes from the contract's `AGENT_VERSION_PROBLEM_CODES`,
 * and equals the status, code and message legacy `POST`/`PATCH /api/agents` answer
 * (`../agents/handlers.ts`), because it is the same unique key refusing.
 */
export function agentNameConflict(name: string): ApiResult {
  return versionProblem(
    'agent_name_conflict',
    `This workspace already has an agent named ${JSON.stringify(name)}.`,
  );
}

/** `409 agent_archived`: the refusal both the pre-lock check and the locked transaction answer. */
export function agentArchived(): ApiResult {
  return versionProblem(
    'agent_archived',
    'This agent is archived; restore it before moving a pointer or saving a version.',
  );
}

/**
 * `409 agent_archived` for a version save or a pointer move on an archived agent, or `null` for an
 * active one. The code and status are the run refusal's (issue #1851): an archived agent is frozen
 * whatever the door, so each write path asks this first, before it reads or writes anything. A move
 * is asked again under the pointer lock (`applyAndPoint` answers `agent-archived`), because an
 * archive can commit between this read and that lock.
 */
export function agentArchivedRefusal(agent: AgentRecord): ApiResult | null {
  return agent.archivedAt === undefined ? null : agentArchived();
}

/** The agent named as the creator is gone, so the lineage foreign key refused the new agent. */
export function creatorAgentGone(): ApiResult {
  return versionProblem(
    'agent_not_found',
    'The agent that is creating this agent is not one of this workspace.',
  );
}

/** The workspace used today's creation quota; the Builder's own refusal table names the status and fix. */
export function quotaExceeded(): ApiResult {
  const { status, fix } = BUILDER_REFUSAL_CODES.quota_exceeded;
  return problem(status, 'quota_exceeded', fix);
}

/**
 * Run `write` with the pipeline's references; on `reference-gone`, re-resolve once and either
 * answer the resolution's refusal or run `write` once more with today's ids. A second
 * `reference-gone` throws.
 */
export async function withReferenceRetry<Outcome extends { readonly kind: string }>(
  references: ResolvedReferences,
  reresolve: () => ReturnType<WorkspaceAgentVersionStore['resolveDefinition']>,
  write: (references: ResolvedReferences) => Promise<Outcome>,
): Promise<{ readonly kind: 'refused'; readonly result: ApiResult } | Outcome> {
  const first = await write(references);
  if (first.kind !== 'reference-gone') return first;
  const again = await reresolve();
  if (again.kind === 'unresolved') return { kind: 'refused', result: resolutionRefusal(again) };
  const second = await write({ ...again.references, storageGrants: references.storageGrants });
  if (second.kind === 'reference-gone') {
    throw new Error(
      'A definition reference was deleted twice between resolving it and writing it; the write ' +
        'was not retried again.',
    );
  }
  return second;
}
