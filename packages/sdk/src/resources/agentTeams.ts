import {
  AgentTeamListResponseSchema,
  AgentTeamResourceSchema,
  AgentTeamVersionListResponseSchema,
  AgentTeamVersionSchema,
  type AgentTeamListResponse,
  type AgentTeamResource,
  type AgentTeamVersion,
  type AgentTeamVersionListResponse,
  type CreateAgentTeamRequest,
  type CreateAgentTeamVersionRequest,
} from '@indx-workspace/contracts/agent-teams';
import { StartRunResponseSchema, type StartRunResponse } from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import { segment, type HttpClient, type RequestOptions } from '../http.js';
import { walkPages } from '../pagination.js';
import { startRunWire, type StartRunInput } from './runs.js';

const NoContentSchema = z.null();

/** `limit` (1–200; the server's default page otherwise) and a previous page's `nextCursor`. */
export interface AgentTeamListQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

function pageQuery(query: AgentTeamListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return params;
}

/**
 * `/api/agent-teams/:id/versions` — a team's immutable versions (ADR-0104 acceptance decision 11).
 * A version pins the lead's and each member's agent version, so a team run is reproducible.
 */
export class AgentTeamVersionsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Save the team's next version: the lead and 1–8 members, each `{ agentId, agentVersionId }`,
   * a member optionally named (its agent's name otherwise). `422 agent_team_member_invalid` when a
   * pin is not a version of an agent of this workspace, the lead is listed as a member, or a
   * member name is not a slug of at most 52 characters or repeats.
   */
  public create(
    teamId: string,
    input: CreateAgentTeamVersionRequest,
    options: RequestOptions = {},
  ): Promise<AgentTeamVersion> {
    return this.#http.json({
      operation: 'agentTeams.versions.create',
      method: 'POST',
      path: `/api/agent-teams/${segment(teamId)}/versions`,
      body: input,
      expect: [201],
      schema: AgentTeamVersionSchema,
      signal: options.signal,
    });
  }

  /** One page of the team's versions, newest first; pass `nextCursor` back as `cursor`. */
  public list(
    teamId: string,
    query: AgentTeamListQuery = {},
    options: RequestOptions = {},
  ): Promise<AgentTeamVersionListResponse> {
    return this.#http.json({
      operation: 'agentTeams.versions.list',
      method: 'GET',
      path: `/api/agent-teams/${segment(teamId)}/versions`,
      query: pageQuery(query),
      expect: [200],
      schema: AgentTeamVersionListResponseSchema,
      signal: options.signal,
    });
  }
}

/**
 * `/api/agent-teams/**` — ADR-0104 (accepted for `handoff` mode), issue #1516, spec 04 §5.18. An
 * agent team is a published unit with a lead agent and up to eight member agents of the same
 * workspace; the lead calls each member as the tool `agent__<member name>`. The routes are
 * authorised as agents: every role reads, a Builder writes its own teams, Owner and Admin any.
 *
 * Problem codes: `400 invalid_agent_team_id`, `404 agent_team_not_found` (also for another
 * workspace's team), `409 agent_team_name_taken`, `422 agent_team_member_invalid`.
 */
export class AgentTeamsClient {
  readonly #http: HttpClient;
  public readonly versions: AgentTeamVersionsClient;

  public constructor(http: HttpClient) {
    this.#http = http;
    this.versions = new AgentTeamVersionsClient(http);
  }

  /** One page of the workspace's teams, newest first; pass `nextCursor` back as `cursor`. */
  public list(
    query: AgentTeamListQuery = {},
    options: RequestOptions = {},
  ): Promise<AgentTeamListResponse> {
    return this.#http.json({
      operation: 'agentTeams.list',
      method: 'GET',
      path: '/api/agent-teams',
      query: pageQuery(query),
      expect: [200],
      schema: AgentTeamListResponseSchema,
      signal: options.signal,
    });
  }

  /** Every team, one page request at a time. Stops after the page whose `nextCursor` is `null`. */
  public listAll(
    query: AgentTeamListQuery = {},
    options: RequestOptions = {},
  ): AsyncGenerator<AgentTeamResource, void, undefined> {
    return walkPages('agentTeams.list', query.cursor, async (cursor) => {
      const page = await this.list(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        options,
      );
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  /** One team with its newest version (`latestVersion: null` before the first). */
  public get(id: string, options: RequestOptions = {}): Promise<AgentTeamResource> {
    return this.#http.json({
      operation: 'agentTeams.get',
      method: 'GET',
      path: `/api/agent-teams/${segment(id)}`,
      expect: [200],
      schema: AgentTeamResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Create a team owned by the caller; `version`, when given, is saved as version 1 in the same
   * write. `409 agent_team_name_taken` when another live team of the workspace has the name.
   */
  public create(
    input: CreateAgentTeamRequest,
    options: RequestOptions = {},
  ): Promise<AgentTeamResource> {
    return this.#http.json({
      operation: 'agentTeams.create',
      method: 'POST',
      path: '/api/agent-teams',
      body: input,
      expect: [201],
      schema: AgentTeamResourceSchema,
      signal: options.signal,
    });
  }

  /** Delete the team; its name is free again and its versions are kept for history. */
  public async remove(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'agentTeams.remove',
      method: 'DELETE',
      path: `/api/agent-teams/${segment(id)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }

  /**
   * Run the team (ADR-0104 acceptance, issue #1517): its newest version's lead starts on a session
   * of the lead agent, sees each member as the tool `agent__<member name>`, and each member call
   * becomes a child run whose `parentRunId` is the lead's run. The answer is the ordinary `202` of
   * {@link RunsClient.start}, with the lead's run; follow it with `runs.follow`, and read the tree
   * with `runs.get` (`children`, `treeCost`). `idempotencyKey` behaves as on `runs.start`.
   *
   * Throws {@link ApiProblemError}: `404 agent_team_not_found`, `409 agent_team_has_no_version`
   * (save a version first), `403` when the caller may not run the lead agent, and every refusal of
   * `runs.start`. `version` is not accepted: the team version pins the lead's.
   */
  public run(
    id: string,
    input: AgentTeamRunInput,
    options: RequestOptions = {},
  ): Promise<StartRunResponse> {
    return this.#http.json({
      operation: 'agentTeams.run',
      method: 'POST',
      path: `/api/agent-teams/${segment(id)}/runs`,
      ...startRunWire(input),
      expect: [202],
      schema: StartRunResponseSchema,
      signal: options.signal,
    });
  }
}

/** What {@link AgentTeamsClient.run} takes: a run start's input, without `version`. */
export type AgentTeamRunInput = Omit<StartRunInput, 'version'>;
