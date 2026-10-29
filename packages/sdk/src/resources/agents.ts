import { z } from 'zod';

import {
  AgentListResponseSchema,
  AgentGrantsSchema,
  AgentPolicyResponseSchema,
  AgentResourceAssignmentsResponseSchema,
  AgentResourceSchema,
  CreateAgentWithAssignmentsResponseSchema,
  type AgentDefinition,
  type AgentPolicy,
  type AgentGrants,
  type AgentListArchived,
  type AgentResource,
  type AgentResourceAssignments,
  type AgentResourceAssignmentsInput,
  type CreateAgentInput,
  type CreateAgentOptions,
  type CreateAgentWithAssignmentsResponse,
  type UpdateAgentPatch,
} from '@indx-workspace/contracts/agents';
import {
  AgentVersionCheckResponseSchema,
  CreateAgentFromVersionResponseSchema,
  type AgentVersionCheckResponse,
  type CreateAgentFromVersionRequestInput,
  type CreateAgentFromVersionResponse,
} from '@indx-workspace/contracts/agent-versions';

import { segment, type HttpClient, type RequestOptions } from '../http.js';
import {
  AgentDefinitions,
  type ImportAgentDefinitionOptions,
  type ImportAgentDefinitionResult,
} from './agent-definitions.js';
import { AgentPointersClient, AgentVersionsClient } from './agent-versions.js';
import { EvaluationsClient } from './evaluations.js';
import { FeedbackClient } from './feedback.js';

export { AgentPointersClient, AgentVersionsClient } from './agent-versions.js';
export { EvaluationsClient } from './evaluations.js';
export { FeedbackClient } from './feedback.js';

const NoContentSchema = z.null();

/** Options of `agents.list`. */
export interface ListAgentsOptions extends RequestOptions {
  /** `'include'` also lists archived agents, each with its `archivedAt`. Default: left out. */
  readonly archived?: AgentListArchived;
}

/** `/api/agents/**` — spec §17 and §34. */
export class AgentsClient {
  /** S1-09 (issue #447): the agent's versions, `/api/agents/:id/versions` (ADR-0101). */
  public readonly versions: AgentVersionsClient;
  /** S1-09 (issue #447): the agent's environment pointers, `/api/agents/:id/pointers` (ADR-0101). */
  public readonly pointers: AgentPointersClient;
  /** Issue #618: score a version against its cases, `/api/agents/:id/evaluations`. */
  public readonly evaluations: EvaluationsClient;
  /** Issue #620: the ratings of the agent's runs, `/api/agents/:id/feedback`. */
  public readonly feedback: FeedbackClient;
  readonly #http: HttpClient;
  readonly #definitions: AgentDefinitions;

  public constructor(http: HttpClient) {
    this.#http = http;
    this.#definitions = new AgentDefinitions(http, this);
    this.versions = new AgentVersionsClient(http);
    this.pointers = new AgentPointersClient(http);
    this.evaluations = new EvaluationsClient(http);
    this.feedback = new FeedbackClient(http);
  }

  /** The workspace's agents; archived ones are left out unless `archived: 'include'` (#1851). */
  public async list(options: ListAgentsOptions = {}): Promise<readonly AgentResource[]> {
    const response = await this.#http.json({
      operation: 'agents.list',
      method: 'GET',
      path: '/api/agents',
      ...(options.archived === undefined
        ? {}
        : { query: new URLSearchParams({ archived: options.archived }) }),
      expect: [200],
      schema: AgentListResponseSchema,
      signal: options.signal,
    });
    return response.agents;
  }

  public async get(agentId: string, options: RequestOptions = {}): Promise<AgentResource> {
    return this.#http.json({
      operation: 'agents.get',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}`,
      expect: [200],
      schema: AgentResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * S1-09 (issue #447; ADR-0101): run the create-from-version pipeline on `input.version` and write
   * nothing (`POST /api/agents {version, dryRun: true}`, `200`; C8). The answer is the number the
   * first version would be saved as (`1`). It refuses exactly what the save below refuses.
   */
  public create(
    input: CreateAgentFromVersionRequestInput & { readonly dryRun: true },
    options?: RequestOptions,
  ): Promise<AgentVersionCheckResponse>;
  /**
   * S1-09 (issue #447; ADR-0101): create the agent from its first version
   * (`POST /api/agents {version}`, `201`). The agent's name is
   * `version.body.definition.agent.name`; the answer is the agent and its version `1`. Requests are
   * not validated here — the server's save pipeline is the one validator.
   *
   * Throws {@link ApiProblemError} with a code from `AGENT_VERSION_PROBLEM_CODES`:
   *
   * - `400 invalid_agent_version` — the body is not a create-from-version request; each `details`
   *   entry is one parse issue. Passing `options.assignments` beside a version is refused this way:
   *   the key is sent, never silently dropped;
   * - `409 agent_name_conflict` — another agent of this workspace already has the name (issue
   *   #480); no `details`;
   * - `403 builder_name_reserved` — the name is one the deployment's `builder.allow` lists, which
   *   only a workspace Owner or Admin may give (#1851); `update` refuses a rename to it the same way;
   * - `409 surface_name_taken` — a surface name is already another agent's (C9); `details` is
   *   `[surface:<name>]` for each;
   * - `422 agent_definition_references_missing` — each `details` entry is `<kind>:<name>`;
   * - the policy and engine refusals `agents.versions.create` lists.
   */
  public create(
    input: CreateAgentFromVersionRequestInput & { readonly dryRun?: undefined },
    options?: RequestOptions,
  ): Promise<CreateAgentFromVersionResponse>;
  /** Creates the agent alone. */
  public create(input: CreateAgentInput, options?: RequestOptions): Promise<AgentResource>;
  /**
   * K-2: creates the agent and its resource assignments in one request — the same rows
   * `create` followed by `replaceResourceAssignments` would produce, written atomically by the
   * server (`POST /api/agents` commits the agent and its assignments in one transaction, so a
   * refused assignment leaves no agent behind). Posting two requests from the client would risk exactly the
   * orphan a single atomic write avoids.
   *
   * Throws {@link ApiProblemError}. The engine-specific code (ADR-0065,
   * `AGENT_POLICY_PROBLEM_CODES` in the contracts) is:
   *
   * - `422 engine_capability_unsupported` — the engine cannot honour a connector or a skill in
   *   `assignments`. `details` is exactly one entry, the capability (`mcp` or `skills`), so the
   *   caller branches on that rather than on the message. Nothing is written: the agent is not
   *   created and the resources are never silently dropped.
   */
  public create(
    input: CreateAgentInput,
    options: RequestOptions & Required<Pick<CreateAgentOptions, 'assignments'>>,
  ): Promise<CreateAgentWithAssignmentsResponse>;
  public create(
    input: CreateAgentInput | CreateAgentFromVersionRequestInput,
    options: RequestOptions & CreateAgentOptions = {},
  ): Promise<
    | AgentResource
    | CreateAgentWithAssignmentsResponse
    | CreateAgentFromVersionResponse
    | AgentVersionCheckResponse
  > {
    if (isCreateFromVersion(input)) return this.#createFromVersion(input, options);
    if (options.assignments === undefined) {
      return this.#http.json({
        operation: 'agents.create',
        method: 'POST',
        path: '/api/agents',
        body: input,
        expect: [201],
        schema: AgentResourceSchema,
        signal: options.signal,
      });
    }
    return this.#http.json({
      operation: 'agents.create',
      method: 'POST',
      path: '/api/agents',
      body: { agent: input, assignments: options.assignments },
      expect: [201],
      schema: CreateAgentWithAssignmentsResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * The `{version}` form of `POST /api/agents`. An `assignments` option is forwarded beside the
   * version so the server's strict parser refuses it, rather than this client accepting an option
   * it would ignore.
   */
  #createFromVersion(
    input: CreateAgentFromVersionRequestInput,
    options: RequestOptions & CreateAgentOptions,
  ): Promise<CreateAgentFromVersionResponse | AgentVersionCheckResponse> {
    const body =
      options.assignments === undefined ? input : { ...input, assignments: options.assignments };
    if (input.dryRun === true) {
      return this.#http.json({
        operation: 'agents.create',
        method: 'POST',
        path: '/api/agents',
        body,
        expect: [200],
        schema: AgentVersionCheckResponseSchema,
        signal: options.signal,
      });
    }
    return this.#http.json({
      operation: 'agents.create',
      method: 'POST',
      path: '/api/agents',
      body,
      expect: [201],
      schema: CreateAgentFromVersionResponseSchema,
      signal: options.signal,
    });
  }

  public async update(
    agentId: string,
    patch: UpdateAgentPatch,
    options: RequestOptions = {},
  ): Promise<AgentResource> {
    return this.#http.json({
      operation: 'agents.update',
      method: 'PATCH',
      path: `/api/agents/${segment(agentId)}`,
      body: patch,
      expect: [200],
      schema: AgentResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Bring back an archived agent (`POST /api/agents/:id/restore`). An agent that is not archived is
   * returned unchanged, so a repeat is safe. Only an Owner, an Admin or the agent's owner may.
   */
  public async restore(agentId: string, options: RequestOptions = {}): Promise<AgentResource> {
    return this.#http.json({
      operation: 'agents.restore',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/restore`,
      expect: [200],
      schema: AgentResourceSchema,
      signal: options.signal,
    });
  }

  public async remove(agentId: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'agents.remove',
      method: 'DELETE',
      path: `/api/agents/${segment(agentId)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }

  /** The files, skills and connectors the agent may reach (`GET /api/agents/:id/resources`). */
  public async getResourceAssignments(
    agentId: string,
    options: RequestOptions = {},
  ): Promise<AgentResourceAssignments> {
    const response = await this.#http.json({
      operation: 'agents.getResourceAssignments',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}/resources`,
      expect: [200],
      schema: AgentResourceAssignmentsResponseSchema,
      signal: options.signal,
    });
    return response.assignments;
  }

  /**
   * Replace every assignment at once (`PUT /api/agents/:id/resources`). The agent's own
   * `writeFiles` permission is a ceiling on a `read-write` file grant; the server applies it and
   * answers with what it actually stored.
   */
  public async replaceResourceAssignments(
    agentId: string,
    assignments: AgentResourceAssignmentsInput,
    options: RequestOptions = {},
  ): Promise<AgentResourceAssignments> {
    const response = await this.#http.json({
      operation: 'agents.replaceResourceAssignments',
      method: 'PUT',
      path: `/api/agents/${segment(agentId)}/resources`,
      body: assignments,
      expect: [200],
      schema: AgentResourceAssignmentsResponseSchema,
      signal: options.signal,
    });
    return response.assignments;
  }

  /** Membership principals explicitly permitted to run this agent. */
  public async getGrants(
    agentId: string,
    options: RequestOptions = {},
  ): Promise<AgentGrants['principalIds']> {
    const response = await this.#http.json({
      operation: 'agents.getGrants',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}/grants`,
      expect: [200],
      schema: AgentGrantsSchema,
      signal: options.signal,
    });
    return response.principalIds;
  }

  /** Atomically replace every membership principal permitted to run this agent. */
  public async replaceGrants(
    agentId: string,
    principalIds: readonly string[],
    options: RequestOptions = {},
  ): Promise<AgentGrants['principalIds']> {
    const response = await this.#http.json({
      operation: 'agents.replaceGrants',
      method: 'PUT',
      path: `/api/agents/${segment(agentId)}/grants`,
      body: { principalIds },
      expect: [200],
      schema: AgentGrantsSchema,
      signal: options.signal,
    });
    return response.principalIds;
  }

  /**
   * S-13: the agent's policy (`GET /api/agents/:id/policy`) — the stored one if a `replacePolicy`
   * has ever run, otherwise the one compiled from `permissions` and the assigned resources.
   */
  public async getPolicy(agentId: string, options: RequestOptions = {}): Promise<AgentPolicy> {
    const response = await this.#http.json({
      operation: 'agents.getPolicy',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}/policy`,
      expect: [200],
      schema: AgentPolicyResponseSchema,
      signal: options.signal,
    });
    return response.policy;
  }

  /**
   * S-13: replace the agent's policy as one operation (`PUT /api/agents/:id/policy`). The server
   * answers exactly what it stored. The agent's permission checkboxes and read-only file grants
   * are applied on top when a run is composed, so a stored policy may restrict the agent further
   * but never widens it past them.
   *
   * Throws {@link ApiProblemError}. The engine-specific codes (ADR-0065,
   * `ENGINE_PROBLEM_CODES` and `AGENT_POLICY_PROBLEM_CODES` in the contracts) are:
   *
   * - `400 unsupported_engine` — `policy.engine` is not an engine this deployment registers;
   * - `422 engine_capability_unsupported` — the engine cannot honour a connector or a skill this
   *   agent is assigned. `details` is exactly one entry, the capability (`mcp` or `skills`), so the
   *   caller branches on that rather than on the message. The resources are never silently dropped.
   * - `422 engine_switch_would_widen` — `policy.engine` differs from the stored policy's, and the
   *   stored arm denies something the new arm cannot express (an MCP tool, an MCP glob, a
   *   wildcard). `details` names each such rule. Everything else the stored arm withheld is carried
   *   into the new arm (`translatePolicyForEngineSwitch`, ADR-0074 D12), so the policy this answers
   *   can be narrower than the one sent.
   */
  public async replacePolicy(
    agentId: string,
    policy: AgentPolicy,
    options: RequestOptions = {},
  ): Promise<AgentPolicy> {
    const response = await this.#http.json({
      operation: 'agents.replacePolicy',
      method: 'PUT',
      path: `/api/agents/${segment(agentId)}/policy`,
      body: policy,
      expect: [200],
      schema: AgentPolicyResponseSchema,
      signal: options.signal,
    });
    return response.policy;
  }

  /**
   * K-1: the agent as a portable {@link AgentDefinition} (`agentworkspace.dev/v1`) — its record,
   * policy and assignments, with every reference to another resource written as that resource's
   * **name** (a file as its workspace path). It carries no id, no credential and no skill bytes;
   * run grants are not exported, because they name principals of this workspace only.
   *
   * Composes `get`, `getPolicy`, `getResourceAssignments` and the skill, connector, model
   * connection, runtime profile and file reads, so it needs the read access each of those needs.
   * Throws {@link ApiProblemError} `409 agent_definition_reference_unresolvable` when an assigned
   * resource's name cannot be read back; `details` lists each as `<kind>:<id>`.
   * `policySource` records whether the policy was stored or compiled (`GET …/policy`'s `source`).
   */
  public export(agentId: string, options: RequestOptions = {}): Promise<AgentDefinition> {
    return this.#definitions.export(agentId, options);
  }

  /**
   * K-1: recreate an exported agent in the workspace this client is bound to, resolving every
   * name inside it. Validates the file first (`400 invalid_agent_definition`), then refuses — before
   * anything is written — an engine this deployment does not install (`400 unsupported_engine`), a
   * name two resources share (`409 agent_definition_reference_ambiguous`), and, unless
   * `onMissing: 'skip'`, any name the workspace lacks (`422 agent_definition_references_missing`).
   * The missing and ambiguous refusals list the offending references in `details` as
   * `<kind>:<name>`; `AGENT_DEFINITION_PROBLEM_CODES` documents every code's `details`.
   *
   * It then creates the agent with its assignments in one call and stores the policy — only when
   * `policySource` is `'stored'`; a compiled policy stays compiled. If a later step fails (the
   * policy is refused with `422 engine_capability_unsupported`, for one, or the call is aborted),
   * the new agent is removed again so a retry never makes a second; if that removal fails too, the
   * original refusal gains an `agent:<id>` entry in `details` (`409
   * agent_definition_import_incomplete` when the failure was not a problem). Skill bytes and
   * credentials never cross: a skill or connector must already exist in the destination under the
   * same name.
   */
  public import(
    definition: unknown,
    options: ImportAgentDefinitionOptions = {},
  ): Promise<ImportAgentDefinitionResult> {
    return this.#definitions.import(definition, options);
  }
}

/**
 * Whether `create` was given the `{version}` form. It checks for a `version` value, not for the
 * key: a legacy input that carries `version: undefined` (allowed by TypeScript on a non-fresh
 * object) sends a legacy body once serialised, so it must take the legacy path and parse the legacy
 * answer. An untyped caller's non-object input also takes the legacy path, so the server answers it
 * with a typed `400` instead of the `in` operator throwing a raw `TypeError` here.
 */
function isCreateFromVersion(
  input: CreateAgentInput | CreateAgentFromVersionRequestInput,
): input is CreateAgentFromVersionRequestInput {
  const candidate: unknown = input;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'version' in candidate &&
    candidate.version !== undefined
  );
}
