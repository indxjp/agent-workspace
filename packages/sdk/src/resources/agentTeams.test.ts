import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, fixtures, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { AgentTeamsClient } from './agentTeams.js';

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = '33333333-3333-4333-8333-333333333333';
const LEAD = {
  agentId: '44444444-4444-4444-8444-444444444441',
  agentVersionId: '44444444-4444-4444-8444-4444444444a1',
};
const MEMBER = {
  agentId: '44444444-4444-4444-8444-444444444442',
  agentVersionId: '44444444-4444-4444-8444-4444444444a2',
};

const version = {
  id: '55555555-5555-4555-8555-555555555555',
  teamId: TEAM_ID,
  workspaceId: WORKSPACE_ID,
  version: 1,
  mode: 'handoff',
  lead: LEAD,
  members: [{ name: 'researcher', ...MEMBER }],
  createdBy: null,
  createdAt: '2026-10-31T00:00:00.000Z',
};

const team = {
  id: TEAM_ID,
  workspaceId: WORKSPACE_ID,
  name: 'Research',
  description: null,
  latestVersion: version,
  ownerPrincipalId: PRINCIPAL_ID,
  createdBy: null,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly teams: AgentTeamsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { teams: new AgentTeamsClient(http), calls: api.calls };
}

describe('AgentTeamsClient', () => {
  it('lists with GET /api/agent-teams, sending limit and cursor only when given', async () => {
    const { teams, calls } = client(() => json(200, { items: [team], nextCursor: 'next' }));
    expect(await teams.list()).toEqual({ items: [team], nextCursor: 'next' });
    await teams.list({ limit: 10, cursor: 'abc' });
    expect(calls.map((call) => [call.method, call.url.pathname, call.url.search])).toEqual([
      ['GET', '/api/agent-teams', ''],
      ['GET', '/api/agent-teams', '?limit=10&cursor=abc'],
    ]);
  });

  it('walks every page with listAll until nextCursor is null', async () => {
    const pages = [
      { items: [team], nextCursor: 'two' },
      {
        items: [{ ...team, id: TEAM_ID.replace('1111', '9999'), name: 'Other' }],
        nextCursor: null,
      },
    ];
    const { teams, calls } = client(() => json(200, pages[calls.length - 1]));
    const names: string[] = [];
    for await (const each of teams.listAll()) names.push(each.name);
    expect(names).toEqual(['Research', 'Other']);
    expect(calls[1]?.url.searchParams.get('cursor')).toBe('two');
  });

  it('reads one team with GET on an encoded id', async () => {
    const { teams, calls } = client(() => json(200, team));
    expect(await teams.get(TEAM_ID)).toEqual(team);
    expect(calls[0]?.url.pathname).toBe(`/api/agent-teams/${TEAM_ID}`);
    await teams.get('a/b');
    expect(calls[1]?.url.pathname).toBe('/api/agent-teams/a%2Fb');
  });

  it('creates with POST, the body as given, and expects 201', async () => {
    const { teams, calls } = client(() => json(201, team));
    const input = { name: 'Research', version: { lead: LEAD, members: [MEMBER] } };
    expect(await teams.create(input)).toEqual(team);
    expect([calls[0]?.method, calls[0]?.url.pathname]).toEqual(['POST', '/api/agent-teams']);
    expect(calls[0]?.json).toEqual(input);
  });

  it('removes with DELETE and resolves on the 204', async () => {
    const { teams, calls } = client(() => new Response(null, { status: 204 }));
    await expect(teams.remove(TEAM_ID)).resolves.toBeUndefined();
    expect([calls[0]?.method, calls[0]?.url.pathname]).toEqual([
      'DELETE',
      `/api/agent-teams/${TEAM_ID}`,
    ]);
  });

  it('saves a version with POST …/versions and lists them with GET', async () => {
    const { teams, calls } = client((request) =>
      request.method === 'POST'
        ? json(201, version)
        : json(200, { items: [version], nextCursor: null }),
    );
    const body = { lead: LEAD, members: [{ ...MEMBER, name: 'researcher' }] };
    expect(await teams.versions.create(TEAM_ID, body)).toEqual(version);
    expect(await teams.versions.list(TEAM_ID, { limit: 5 })).toEqual({
      items: [version],
      nextCursor: null,
    });
    expect(calls.map((call) => [call.method, `${call.url.pathname}${call.url.search}`])).toEqual([
      ['POST', `/api/agent-teams/${TEAM_ID}/versions`],
      ['GET', `/api/agent-teams/${TEAM_ID}/versions?limit=5`],
    ]);
    expect(calls[0]?.json).toEqual(body);
  });

  it('raises the problem a refusal names, and a contract violation for a malformed team', async () => {
    const refused = client(() =>
      json(422, { error: { code: 'agent_team_member_invalid', message: 'No.' } }),
    );
    const problem = await refused.teams.versions
      .create(TEAM_ID, { lead: LEAD, members: [MEMBER] })
      .catch((error: unknown) => error);
    expect(problem).toBeInstanceOf(ApiProblemError);
    expect((problem as ApiProblemError).code).toBe('agent_team_member_invalid');

    const malformed = client(() => json(200, { ...team, mode: 'switcher' }));
    await expect(malformed.teams.get(TEAM_ID)).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('runs with POST /api/agent-teams/:id/runs, the run-start body and the Idempotency-Key', async () => {
    const run = fixtures.run({ status: 'queued' });
    const { teams, calls } = client(() => json(202, { run, events: `/api/runs/${run.id}/events` }));
    const started = await teams.run(TEAM_ID, {
      prompt: 'Write the launch note.',
      idempotencyKey: 'note-1',
    });
    expect(started.run.id).toBe(run.id);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agent-teams/${TEAM_ID}/runs`);
    expect(calls[0]?.headers.get('idempotency-key')).toBe('note-1');
    expect(calls[0]?.json).toEqual({
      prompt: 'Write the launch note.',
      sessionId: null,
      modelConnectionId: null,
      model: null,
    });
  });

  it('raises agent_team_has_no_version for a team with no version', async () => {
    const { teams } = client(() =>
      json(409, { error: { code: 'agent_team_has_no_version', message: 'No version.' } }),
    );
    const problem = await teams.run(TEAM_ID, { prompt: 'Hi' }).catch((error: unknown) => error);
    expect(problem).toBeInstanceOf(ApiProblemError);
    expect((problem as ApiProblemError).code).toBe('agent_team_has_no_version');
  });
});
