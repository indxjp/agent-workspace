/**
 * `POST /api/agent-teams/:id/runs` — run an agent team (ADR-0104 acceptance decisions 4, 10 and
 * 11, issue #1517, spec 04 §5.18).
 *
 * A team run is a run of its lead: the team's newest version pins the lead's version, and the
 * start is the ordinary run start of the lead (`startAuthorisedRun`, the path behind
 * `POST /api/agents/:id/runs`), so the body, the `Idempotency-Key` and every refusal are the same.
 * The run records the team version it runs, which composition reads to give the lead its member
 * server and the member endpoint reads to list the members. Authorised as the `run` verb on the
 * lead agent: `decide()` reads the `agent-teams` segment as the `agents` resource, and ownership
 * is the lead agent's, so a person runs a team exactly when they may run its lead.
 */
import { AGENT_TEAM_PROBLEM_CODES } from '@indx-workspace/contracts/agent-teams';

import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { applicationContext } from '../application-context';
import {
  notConfigured,
  requireRunPermission,
  startAuthorisedRun,
  unauthenticated,
} from '../runs/api';
import { getRunApi } from '../runs/environment';
import { apiError, isUuid } from '../execution';
import type { AgentTeamVersionRecord, AgentTeamsRuntime } from './runtime';

type TeamVersionRead =
  | { readonly kind: 'version'; readonly version: AgentTeamVersionRecord }
  | { readonly kind: 'refused'; readonly response: Response };

/** The team's newest version in `workspaceId`, or the problem its absence answers. */
async function latestTeamVersion(
  runtime: AgentTeamsRuntime | null,
  workspaceId: string,
  teamId: string,
): Promise<TeamVersionRead> {
  if (runtime === null) {
    return {
      kind: 'refused',
      response: apiError(
        503,
        'agent_teams_not_configured',
        'The agent-team routes have no runtime installed.',
      ),
    };
  }
  if (!isUuid(teamId)) {
    return {
      kind: 'refused',
      response: apiError(
        AGENT_TEAM_PROBLEM_CODES.invalid_agent_team_id,
        'invalid_agent_team_id',
        `${JSON.stringify(teamId)} is not a team id.`,
      ),
    };
  }
  const team = await (await runtime.repository(workspaceId)).get(teamId);
  if (team === null) {
    return {
      kind: 'refused',
      response: apiError(
        AGENT_TEAM_PROBLEM_CODES.agent_team_not_found,
        'agent_team_not_found',
        `No agent team ${teamId} in this workspace.`,
      ),
    };
  }
  if (team.latestVersion === null) {
    return {
      kind: 'refused',
      response: apiError(
        AGENT_TEAM_PROBLEM_CODES.agent_team_has_no_version,
        'agent_team_has_no_version',
        'This agent team has no version yet, so it has no lead to run; save a version first.',
      ),
    };
  }
  return { kind: 'version', version: team.latestVersion };
}

/** `POST /api/agent-teams/:id/runs`: `202` with the lead's run, as `POST /api/agents/:id/runs`. */
export async function startAgentTeamRun(request: Request, teamId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  // `decide()` reads this route as the `run` verb on `agents`, which a session, A2A or app-backend
  // scope reaches for its own agent. A scope names one agent or session, never a team, and a team
  // run reaches agents the scope does not name, so no scoped credential runs a team.
  if (principal.scope !== null) {
    return apiError(
      403,
      'token_out_of_scope',
      'a scoped credential runs only the agent or session it names, never an agent team.',
    );
  }
  const read = await latestTeamVersion(
    applicationContext()?.agentTeams ?? null,
    principal.workspaceId,
    teamId,
  );
  if (read.kind === 'refused') return read.response;
  const { version } = read;
  const ownership = await resolveAgentRunOwnership(principal, version.lead.agentId);
  const permission = requireRunPermission(request, principal, ownership);
  if (permission !== null) return permission;
  return startAuthorisedRun({ request, env, principal }, version.lead.agentId, {
    agentVersionId: version.lead.agentVersionId,
    agentTeamVersionId: version.id,
  });
}
