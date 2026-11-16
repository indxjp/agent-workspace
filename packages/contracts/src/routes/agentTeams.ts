import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok } from './definition.js';
export const agentTeamsRoutes: readonly ApiRoute[] = [
  // §5.18 — agent teams (ADR-0104 acceptance, issue #1516). Authorised as the `agents` resource.
  {
    method: 'GET',
    path: '/api/agent-teams',
    operationId: 'agentTeams.list',
    tag: 'agentTeams',
    feature: 'core',
    summary: "List the workspace's agent teams, newest first, cursor paged",
    success: ok(json('AgentTeamListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/agent-teams',
    operationId: 'agentTeams.create',
    tag: 'agentTeams',
    feature: 'core',
    summary: 'Create an agent team, with its first version when the body carries one',
    request: json('CreateAgentTeamRequestSchema'),
    success: created(json('AgentTeamResourceSchema')),
  },

  {
    method: 'GET',
    path: '/api/agent-teams/:id',
    operationId: 'agentTeams.get',
    tag: 'agentTeams',
    feature: 'core',
    summary: 'Read one agent team with its newest version',
    success: ok(json('AgentTeamResourceSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/agent-teams/:id',
    operationId: 'agentTeams.remove',
    tag: 'agentTeams',
    feature: 'core',
    summary: 'Delete an agent team; its name becomes free again',
    success: NO_CONTENT,
  },

  {
    method: 'POST',
    path: '/api/agent-teams/:id/versions',
    operationId: 'agentTeams.versions.create',
    tag: 'agentTeams',
    feature: 'core',
    summary: "Save a team's next immutable version, pinning the lead's and each member's version",
    request: json('CreateAgentTeamVersionRequestSchema'),
    success: created(json('AgentTeamVersionSchema')),
  },

  {
    method: 'GET',
    path: '/api/agent-teams/:id/versions',
    operationId: 'agentTeams.versions.list',
    tag: 'agentTeams',
    feature: 'core',
    summary: "List a team's versions, newest first, cursor paged",
    success: ok(json('AgentTeamVersionListResponseSchema')),
  },

  // ADR-0104 acceptance decisions 4 and 11 (issue #1517): a run of the team's newest version on
  // its lead, decided as the `run` verb on the lead agent.
  {
    method: 'POST',
    path: '/api/agent-teams/:id/runs',
    operationId: 'agentTeams.run',
    tag: 'agentTeams',
    feature: 'core',
    summary: "Run an agent team: start its newest version's lead, which calls the members",
    request: json('StartRunRequestSchema'),
    headers: [
      {
        name: 'Idempotency-Key',
        required: false,
        description:
          'Makes a retried team run safe exactly as on `POST /api/agents/:id/runs` (S-6, ' +
          'ADR-0151): the same key with the same request returns the run the first start ' +
          'queued; the same key with a different request answers `409 run_idempotency_conflict`.',
      },
    ],
    success: [{ status: 202, body: json('StartRunResponseSchema') }],
  },
];
