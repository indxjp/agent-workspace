import {
  AgentPointerMoveResponseSchema,
  AgentVersionCheckResponseSchema,
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
  SetAgentPointerResponseSchema,
  type AgentPointerMoveResponse,
  type AgentVersionCheckResponse,
  type AgentVersionDraftInput,
  type AgentVersionListResponse,
  type AgentVersionResource,
  type PromoteAgentRequest,
  type RollbackAgentRequestInput,
  type SetAgentPointerRequest,
  type SetAgentPointerResponse,
} from '@indx-workspace/contracts/agent-versions';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

/** A promote request; `dryRun` is {@link AgentPointersClient.checkPromote}'s to send. */
type PromoteAgentInput = Omit<PromoteAgentRequest, 'dryRun'>;
/** A rollback request; `dryRun` is {@link AgentPointersClient.checkRollback}'s to send. */
type RollbackAgentInput = Omit<RollbackAgentRequestInput, 'dryRun'>;

/**
 * `/api/agents/:id/versions` — S1-09 (issue #447), ADR-0101. A version is an immutable, numbered
 * snapshot of one agent's definition and its surfaces; saving one does not change what the agent
 * runs until an environment's pointer is moved to it ({@link AgentPointersClient.set}).
 *
 * Requests are not validated here: the server's one save pipeline (C8) is the validator, so every
 * refusal arrives as an {@link ApiProblemError} whose `code` is one of the contracts'
 * `AGENT_VERSION_PROBLEM_CODES`. Responses are parsed with the contracts schemas, and a malformed
 * one raises {@link ContractViolationError} naming the operation.
 */
export class AgentVersionsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * The agent's versions and its environment pointers (`GET /api/agents/:id/versions`). The whole
   * answer is returned because the pointers — which version each environment runs — are part of
   * it.
   *
   * Throws {@link ApiProblemError}: `400 invalid_agent_id` (the id is not a UUID) and
   * `404 agent_not_found`.
   */
  public async list(
    agentId: string,
    options: RequestOptions = {},
  ): Promise<AgentVersionListResponse> {
    return this.#http.json({
      operation: 'agents.listVersions',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}/versions`,
      expect: [200],
      schema: AgentVersionListResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Save `draft` as the agent's next version (`POST /api/agents/:id/versions`, `201`). The pointers
   * do not move. To run the same pipeline without writing, call {@link check}; a `dryRun` key
   * smuggled into `draft` from untyped code makes the server answer `200`, which this method does
   * not expect and reports as an {@link ApiProblemError} (`unrecognised_error_body`) — the key is
   * sent as given, never stripped.
   *
   * Throws {@link ApiProblemError} with a code from `AGENT_VERSION_PROBLEM_CODES`:
   *
   * - `400 invalid_agent_version` — the body is not a version; each `details` entry is one parse
   *   issue, `<dotted.path>: <message>`;
   * - `400 unsupported_engine`, `400 dangerous_permission_mode_refused` — the definition's policy;
   * - `404 agent_not_found`, `503 agent_policy_not_configured`;
   * - `422 agent_definition_references_missing` / `409 agent_definition_reference_ambiguous` — each
   *   `details` entry is `<kind>:<name>`;
   * - `422 engine_capability_unsupported` — `details` is the capability (`mcp` or `skills`);
   * - `422 engine_switch_would_widen` — each `details` entry is a rule the new engine cannot keep.
   */
  public async create(
    agentId: string,
    draft: AgentVersionDraftInput,
    options: RequestOptions = {},
  ): Promise<AgentVersionResource> {
    return this.#http.json({
      operation: 'agents.createVersion',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/versions`,
      body: draft,
      expect: [201],
      schema: AgentVersionResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Run the whole save pipeline on `draft` and write nothing (`POST /api/agents/:id/versions` with
   * `dryRun: true`, `200`; C8). The answer is the number the version would be saved as. It refuses
   * exactly what {@link create} refuses, with the same codes and `details`.
   */
  public async check(
    agentId: string,
    draft: AgentVersionDraftInput,
    options: RequestOptions = {},
  ): Promise<AgentVersionCheckResponse> {
    return this.#http.json({
      operation: 'agents.createVersion',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/versions`,
      body: { ...draft, dryRun: true },
      expect: [200],
      schema: AgentVersionCheckResponseSchema,
      signal: options.signal,
    });
  }
}

/**
 * `/api/agents/:id/pointers` — S1-09 (issue #447), ADR-0101. A pointer names the version an
 * environment runs; moving it applies that version to the agent.
 */
export class AgentPointersClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Point `request.environment` at version `request.version` (`PUT /api/agents/:id/pointers`). The
   * answer is the agent as it now runs and the pointer.
   *
   * Throws {@link ApiProblemError} with a code from `AGENT_VERSION_PROBLEM_CODES`:
   *
   * - `400 invalid_agent_version` — the body is not a pointer move (an unknown environment, for
   *   one); each `details` entry is one parse issue;
   * - `404 agent_not_found`; `404 agent_version_not_found` — `details` is `[version:<n>]`;
   * - `409 agent_name_conflict` — the version renames the agent to a name another agent holds
   *   (issue #480); no `details`;
   * - `409 surface_name_taken` — the version's surfaces would give the workspace two surfaces of
   *   one name (C9); `details` is `[surface:<name>]` for each;
   * - the definition refusals {@link AgentVersionsClient.create} lists, when the stored version no
   *   longer applies to this workspace.
   */
  public async set(
    agentId: string,
    request: SetAgentPointerRequest,
    options: RequestOptions = {},
  ): Promise<SetAgentPointerResponse> {
    return this.#http.json({
      operation: 'agents.setPointer',
      method: 'PUT',
      path: `/api/agents/${segment(agentId)}/pointers`,
      body: request,
      expect: [200],
      schema: SetAgentPointerResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Point `production` at the version `local` points at, or at `request.version`
   * (`POST /api/agents/:id/promote`, issue #615). The answer is `production`'s version before and
   * after the move, with `saved: true`. To decide and validate the move without writing, call
   * {@link checkPromote}.
   *
   * Throws {@link ApiProblemError} with whatever code the server answers, among them:
   *
   * - `409 no_pointer` — `local` points at no version, so there is nothing to promote;
   * - `404 agent_not_found`; `404 agent_version_not_found` — `details` is `[version:<n>]`;
   * - `400 invalid_agent_version` — the body is not a promote request;
   * - the refusals {@link set} lists, when the version no longer applies to this workspace.
   */
  public async promote(
    agentId: string,
    request: PromoteAgentInput = {},
    options: RequestOptions = {},
  ): Promise<AgentPointerMoveResponse> {
    return this.#http.json({
      operation: 'agents.promote',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/promote`,
      body: request,
      expect: [200],
      schema: AgentPointerMoveResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * {@link promote} with `dryRun: true`: the same decision and refusals, and nothing is written
   * (`saved: false`).
   */
  public async checkPromote(
    agentId: string,
    request: PromoteAgentInput = {},
    options: RequestOptions = {},
  ): Promise<AgentPointerMoveResponse> {
    return this.#http.json({
      operation: 'agents.promote',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/promote`,
      body: { ...request, dryRun: true },
      expect: [200],
      schema: AgentPointerMoveResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Point `request.environment` (default `production`) back at the version before its pointer's
   * (`POST /api/agents/:id/rollback`, issue #615). A rollback steps back past the version it left,
   * so rolling back twice goes two versions back, never forward again. To check the move without
   * writing, call {@link checkRollback}.
   *
   * Throws {@link ApiProblemError} with whatever code the server answers, among them
   * `409 nothing_to_roll_back` (no history entry before the pointer), `404 agent_not_found`,
   * `400 invalid_agent_version`, and the refusals {@link set} lists when the earlier version no
   * longer applies to this workspace.
   */
  public async rollback(
    agentId: string,
    request: RollbackAgentInput = {},
    options: RequestOptions = {},
  ): Promise<AgentPointerMoveResponse> {
    return this.#http.json({
      operation: 'agents.rollback',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/rollback`,
      body: request,
      expect: [200],
      schema: AgentPointerMoveResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * {@link rollback} with `dryRun: true`: the same decision and refusals, and nothing is written
   * (`saved: false`).
   */
  public async checkRollback(
    agentId: string,
    request: RollbackAgentInput = {},
    options: RequestOptions = {},
  ): Promise<AgentPointerMoveResponse> {
    return this.#http.json({
      operation: 'agents.rollback',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/rollback`,
      body: { ...request, dryRun: true },
      expect: [200],
      schema: AgentPointerMoveResponseSchema,
      signal: options.signal,
    });
  }
}
