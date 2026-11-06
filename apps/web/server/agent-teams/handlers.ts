/**
 * `/api/agent-teams/**` — ADR-0104 (accepted for `handoff` mode), issue #1516, spec 04 §5.18: list,
 * create, read and delete a workspace's agent teams, and save and list their immutable versions.
 * Running a team (`POST /api/agent-teams/:id/runs`) and the member endpoint are U4.2c's.
 *
 * Every handler begins with `authorise()`, which decides `/api/agent-teams/**` as the `agents`
 * resource (acceptance decision 10): every role reads, Builder writes its own teams, Owner and
 * Admin write any. A route with an `:id` resolves the team first, so a team in another workspace
 * answers the same `404 agent_team_not_found` as an id that never existed. Every write is audited.
 */
import { isUuid } from '@indx-workspace/contracts';
import {
  AGENT_TEAM_PROBLEM_CODES,
  CreateAgentTeamRequestSchema,
  CreateAgentTeamVersionRequestSchema,
  type AgentTeamListResponse,
  type AgentTeamProblemCode,
  type AgentTeamVersionListResponse,
} from '@indx-workspace/contracts/agent-teams';

import { applicationContext } from '../application-context';
import { formatIssues, problem, readJsonBody, type ApiResult } from '../http/result';
import { encodeListCursor } from '../pagination/list-cursor';
import { authorise, type OwnershipResolver } from '../rbac/http';
import type { Principal } from '../rbac/principal';
import {
  encodeVersionCursor,
  readTeamListQuery,
  readVersionListQuery,
  toAgentTeamResource,
  toAgentTeamVersion,
} from './contract';
import type {
  AgentTeamMemberInvalid,
  AgentTeamRecord,
  AgentTeamRepository,
  AgentTeamsRuntime,
} from './runtime';

function domainProblem(code: AgentTeamProblemCode, message: string): ApiResult {
  return problem(AGENT_TEAM_PROBLEM_CODES[code], code, message);
}

const notConfigured = (): ApiResult =>
  problem(503, 'agent_teams_not_configured', 'The agent-team routes have no runtime installed.');

const teamNotFound = (id: string): ApiResult =>
  domainProblem('agent_team_not_found', `No agent team ${id} in this workspace.`);

const MEMBER_PROBLEM_TEXT: Readonly<Record<AgentTeamMemberInvalid['problem'], string>> = {
  'member-count': 'A team version has 1 to 8 members.',
  'lead-is-member': 'The lead agent must not also be a member.',
  'duplicate-agent': 'An agent may be a member once.',
  'unknown-version': 'Every lead and member must pin a version of an agent of this workspace.',
  'member-name-invalid':
    "A member's name must be a slug of at most 52 characters; name the member explicitly.",
  'member-name-repeated': 'Member names must not repeat.',
};

function memberInvalid(outcome: AgentTeamMemberInvalid): ApiResult {
  const about = outcome.agentId === undefined ? '' : ` (agent ${outcome.agentId})`;
  return domainProblem(
    'agent_team_member_invalid',
    `${MEMBER_PROBLEM_TEXT[outcome.problem]}${about}`,
  );
}

type Issue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

/** Issue codes that say the body is malformed (a missing or mistyped field, an unknown key). */
const MALFORMED_ISSUE_CODES: ReadonlySet<string> = new Set(['invalid_type', 'unrecognized_keys']);

/**
 * A body the contract refuses. Spec 04 §5.18 answers a lead or member list whose values are wrong
 * (more than 8 members, the lead listed, a repeated agent or name, a name that is no slug) as
 * `422 agent_team_member_invalid`, so a refusal whose every issue is such a value under `lead` or
 * `members` says that. A malformed body — a missing or mistyped field, an unknown key — and
 * anything else is `400 invalid_body`.
 */
function refusedBody(issues: readonly Issue[], versionPath: readonly PropertyKey[]): ApiResult {
  const details = formatIssues(issues);
  const isMemberIssue = (issue: Issue): boolean => {
    const head = issue.path.slice(0, versionPath.length);
    const field = issue.path[versionPath.length];
    return (
      !MALFORMED_ISSUE_CODES.has(issue.code) &&
      head.every((segment, at) => segment === versionPath[at]) &&
      (field === 'lead' || field === 'members')
    );
  };
  if (issues.length > 0 && issues.every(isMemberIssue)) {
    return problem(
      AGENT_TEAM_PROBLEM_CODES.agent_team_member_invalid,
      'agent_team_member_invalid',
      'The lead or the members are not a valid team version.',
      details,
    );
  }
  return problem(
    400,
    'invalid_body',
    'The request body is not a valid agent team request.',
    details,
  );
}

/** The installed agent-team runtime, or `null` (the routes then answer `503`). */
function teamsRuntime(): AgentTeamsRuntime | null {
  return applicationContext()?.agentTeams ?? null;
}

/** What a resolver read for the handler: the runtime, the repository and the team. */
interface Loaded {
  runtime: AgentTeamsRuntime | null;
  repository: AgentTeamRepository | null;
  team: AgentTeamRecord | null;
}

/**
 * Resolve the team `:id` names in the caller's workspace before `decide()` compares owners: not a
 * UUID is `400 invalid_agent_team_id`, absent or foreign is `404`, and the owner principal is the
 * one own/other is read against, as on agents.
 */
function loadingTeam(id: string): {
  readonly resolver: OwnershipResolver;
  readonly loaded: Loaded;
} {
  const loaded: Loaded = { runtime: null, repository: null, team: null };
  const resolver: OwnershipResolver = async (principal: Principal) => {
    const runtime = teamsRuntime();
    if (runtime === null) return { kind: 'refuse', result: notConfigured() };
    if (!isUuid(id)) {
      return {
        kind: 'refuse',
        result: domainProblem('invalid_agent_team_id', `${JSON.stringify(id)} is not a team id.`),
      };
    }
    const repository = await runtime.repository(principal.workspaceId);
    const team = await repository.get(id);
    if (team === null) return { kind: 'refuse', result: teamNotFound(id) };
    Object.assign(loaded, { runtime, repository, team });
    return {
      kind: 'ownership',
      ownership: team.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other',
    };
  };
  return { resolver, loaded };
}

/** The loaded triple, which `authorise` only reaches after the resolver filled it. */
function loadedTeam(loaded: Loaded): {
  runtime: AgentTeamsRuntime;
  repository: AgentTeamRepository;
  team: AgentTeamRecord;
} {
  const { runtime, repository, team } = loaded;
  if (runtime === null || repository === null || team === null) {
    throw new Error('the agent-team resolver allowed a request without loading its team');
  }
  return { runtime, repository, team };
}

async function audit(
  runtime: AgentTeamsRuntime,
  principal: Principal,
  team: { readonly id: string; readonly name: string },
  what: string,
): Promise<void> {
  await runtime.recordAudit({
    workspaceId: principal.workspaceId,
    actorPrincipalId: principal.principalId,
    actorUserId: principal.userId,
    actorLabel: principal.label,
    action: 'agent-changed',
    subjectId: team.id,
    subjectLabel: `agent team ${team.name}: ${what}`,
  });
}

const invalidQuery = (reason: string): ApiResult =>
  problem(400, 'invalid_query', `The query is not a valid list query: ${reason}`);

/** `GET /api/agent-teams`: live teams, newest first, cursor paged. */
export async function listAgentTeams(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = teamsRuntime();
    if (runtime === null) return notConfigured();
    const query = readTeamListQuery(new URL(request.url).searchParams, principal.workspaceId);
    if (!query.ok) return invalidQuery(query.reason);
    const repository = await runtime.repository(principal.workspaceId);
    const page = await repository.list({ limit: query.limit, cursor: query.cursor });
    const body: AgentTeamListResponse = {
      items: page.items.map(toAgentTeamResource),
      nextCursor:
        page.nextCursor === null
          ? null
          : encodeListCursor('agent-teams', principal.workspaceId, page.nextCursor),
    };
    return { status: 200, body };
  });
}

/** `POST /api/agent-teams`: a team owned by the caller, with version 1 when the body has one. */
export async function createAgentTeam(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = teamsRuntime();
    if (runtime === null) return notConfigured();
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const parsed = CreateAgentTeamRequestSchema.safeParse(raw.value);
    if (!parsed.success) return refusedBody(parsed.error.issues, ['version']);
    const { name, description, version } = parsed.data;
    const repository = await runtime.repository(principal.workspaceId);
    const outcome = await repository.create({
      name,
      ...(description === undefined ? {} : { description }),
      ownerPrincipalId: principal.ownerPrincipalId,
      createdBy: principal.userId,
      ...(version === undefined ? {} : { version }),
    });
    switch (outcome.kind) {
      case 'created':
        await audit(runtime, principal, outcome.team, 'created');
        return { status: 201, body: toAgentTeamResource(outcome.team) };
      case 'name-taken':
        return domainProblem(
          'agent_team_name_taken',
          `Another agent team of this workspace is named ${JSON.stringify(name)}.`,
        );
      case 'member-invalid':
        return memberInvalid(outcome);
      case 'unknown-principal':
        throw new Error(
          `The team store does not know principal ${principal.ownerPrincipalId}, which RBAC ` +
            'authenticated in this workspace; the principal invariant is broken.',
        );
    }
  });
}

/** `GET /api/agent-teams/:id`: one team with its newest version. */
export async function getAgentTeam(request: Request, id: unknown): Promise<ApiResult> {
  const { resolver, loaded } = loadingTeam(String(id));
  return authorise(request, resolver, () =>
    Promise.resolve({ status: 200, body: toAgentTeamResource(loadedTeam(loaded).team) }),
  );
}

/** `DELETE /api/agent-teams/:id`: soft-delete; the name is free again. `204`. */
export async function deleteAgentTeam(request: Request, id: unknown): Promise<ApiResult> {
  const { resolver, loaded } = loadingTeam(String(id));
  return authorise(request, resolver, async ({ principal }) => {
    const { runtime, repository, team } = loadedTeam(loaded);
    if (!(await repository.softDelete(team.id))) return teamNotFound(team.id);
    await audit(runtime, principal, team, 'deleted');
    return { status: 204, body: null };
  });
}

/** `POST /api/agent-teams/:id/versions`: the team's next immutable version. `201`. */
export async function createAgentTeamVersion(request: Request, id: unknown): Promise<ApiResult> {
  const { resolver, loaded } = loadingTeam(String(id));
  return authorise(request, resolver, async ({ principal }) => {
    const { runtime, repository, team } = loadedTeam(loaded);
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const parsed = CreateAgentTeamVersionRequestSchema.safeParse(raw.value);
    if (!parsed.success) return refusedBody(parsed.error.issues, []);
    const outcome = await repository.createVersion(team.id, {
      ...parsed.data,
      createdBy: principal.userId,
    });
    switch (outcome.kind) {
      case 'created':
        await audit(runtime, principal, team, `version ${String(outcome.version.number)} saved`);
        return { status: 201, body: toAgentTeamVersion(outcome.version) };
      case 'not-found':
        return teamNotFound(team.id);
      case 'member-invalid':
        return memberInvalid(outcome);
    }
  });
}

/** `GET /api/agent-teams/:id/versions`: newest first, cursor paged. */
export async function listAgentTeamVersions(request: Request, id: unknown): Promise<ApiResult> {
  const { resolver, loaded } = loadingTeam(String(id));
  return authorise(request, resolver, async () => {
    const { repository, team } = loadedTeam(loaded);
    const query = readVersionListQuery(new URL(request.url).searchParams, team.id);
    if (!query.ok) return invalidQuery(query.reason);
    const page = await repository.listVersions(team.id, {
      limit: query.limit,
      cursor: query.cursor,
    });
    if (page === null) return teamNotFound(team.id);
    const body: AgentTeamVersionListResponse = {
      items: page.items.map(toAgentTeamVersion),
      nextCursor: page.nextCursor === null ? null : encodeVersionCursor(team.id, page.nextCursor),
    };
    return { status: 200, body };
  });
}
