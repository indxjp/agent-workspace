/**
 * `POST /api/agent-teams/:id/runs` (ADR-0104 acceptance decisions 4, 10 and 11, issue #1517): the
 * team's newest version starts on its lead, as a run start of the lead, recording the version.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST } from '../../app/api/agent-teams/[id]/runs/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains, installTestRunApi } from '../application-context-fixtures';
import type { AgentRef, LaunchContext, RunApiEnvironment, RunPrincipal } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { createInMemoryAgentTeamsRuntime } from './memory-store';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const LEAD = {
  agentId: '10000000-0000-4000-8000-000000000001',
  agentVersionId: '10000000-0000-4000-8000-0000000000a1',
};
const MEMBER = {
  agentId: '10000000-0000-4000-8000-000000000002',
  agentVersionId: '10000000-0000-4000-8000-0000000000a2',
};
const OWNER: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

let store: InMemoryRunStore;
let launched: LaunchContext[];
let openedWith: (string | undefined)[];
let principal: RunPrincipal;
let teams: ReturnType<typeof createInMemoryAgentTeamsRuntime>;

beforeEach(() => {
  store = new InMemoryRunStore();
  launched = [];
  openedWith = [];
  principal = OWNER;
  const environment: RunApiEnvironment = {
    authenticate: (request) =>
      Promise.resolve(request.headers.get('x-test-user') === null ? null : principal),
    findAgent: (caller, agentId): Promise<AgentRef | null> =>
      Promise.resolve(
        agentId === LEAD.agentId
          ? { id: agentId, workspaceId: caller.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (_caller, agent, requested, agentVersionId) => {
      openedWith.push(agentVersionId);
      return Promise.resolve({
        id: requested ?? crypto.randomUUID(),
        agentId: agent.id,
        engine: null,
      });
    },
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context) => {
      launched.push(context);
    },
  };
  installTestRunApi(environment);
  teams = createInMemoryAgentTeamsRuntime({
    lookup: (workspaceId, agentId, agentVersionId) =>
      workspaceId === WORKSPACE &&
      [LEAD, MEMBER].some((pin) => pin.agentId === agentId && pin.agentVersionId === agentVersionId)
        ? agentId === LEAD.agentId
          ? 'lead'
          : 'writer'
        : null,
  });
  installTestDomains({ agentTeams: teams });
});

afterEach(() => {
  clearApplicationContext();
});

async function team(withVersion: boolean, label = 'Launch'): Promise<string> {
  const created = await (
    await teams.repository(WORKSPACE)
  ).create({
    name: withVersion ? label : 'Empty',
    ownerPrincipalId: OWNER.principalId,
    createdBy: null,
    ...(withVersion ? { version: { lead: LEAD, members: [MEMBER] } } : {}),
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  return created.team.id;
}

function run(teamId: string, body: unknown, headers: Record<string, string> = {}) {
  const request = new Request(`http://web.test/api/agent-teams/${teamId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': '1', ...headers },
    body: JSON.stringify(body),
  });
  return POST(new NextRequest(request), { params: Promise.resolve({ id: teamId }) });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code ?? '(none)';
}

describe('POST /api/agent-teams/:id/runs', () => {
  it("starts the newest version's lead, pinned to the lead's version, and records the team version", async () => {
    const teamId = await team(true);
    const latest = (await (await teams.repository(WORKSPACE)).get(teamId))?.latestVersion;
    const response = await run(teamId, { prompt: 'Write the launch note.' });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      run: { id: string; agentId: string; parentRunId: null };
    };
    expect(body.run).toMatchObject({ agentId: LEAD.agentId, parentRunId: null });
    expect(openedWith).toEqual([LEAD.agentVersionId]);
    expect((await store.get(body.run.id))?.agentTeamVersionId).toBe(latest?.id);
    expect(launched).toHaveLength(1);
  });

  it('replays a start with the same Idempotency-Key', async () => {
    const teamId = await team(true);
    const first = await run(teamId, { prompt: 'x' }, { 'idempotency-key': 'k-1' });
    const again = await run(teamId, { prompt: 'x' }, { 'idempotency-key': 'k-1' });
    const ids = await Promise.all(
      [first, again].map(
        async (response) => ((await response.json()) as { run: { id: string } }).run.id,
      ),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(launched).toHaveLength(1);
  });

  it("does not replay another team's run for the same key and body (the team version is part of the request)", async () => {
    const first = await team(true, 'Launch');
    const second = await team(true, 'Launch two');
    const started = await run(first, { prompt: 'x' }, { 'idempotency-key': 'k-2' });
    expect(started.status).toBe(202);
    const other = await run(second, { prompt: 'x' }, { 'idempotency-key': 'k-2' });
    expect([other.status, await codeOf(other)]).toEqual([409, 'run_idempotency_conflict']);
    expect(launched).toHaveLength(1);
  });

  it('refuses a team with no version, an unknown team, a bad id and a version in the body', async () => {
    const empty = await team(false);
    const noVersion = await run(empty, { prompt: 'x' });
    expect([noVersion.status, await codeOf(noVersion)]).toEqual([409, 'agent_team_has_no_version']);
    const unknown = await run('99999999-9999-4999-8999-999999999999', { prompt: 'x' });
    expect([unknown.status, await codeOf(unknown)]).toEqual([404, 'agent_team_not_found']);
    const bad = await run('not-a-team', { prompt: 'x' });
    expect([bad.status, await codeOf(bad)]).toEqual([400, 'invalid_agent_team_id']);
    const pinned = await run(await team(true), { prompt: 'x', version: 2 });
    expect([pinned.status, await codeOf(pinned)]).toEqual([400, 'invalid_body']);
    expect(launched).toEqual([]);
  });

  it('is authorised as running the lead agent, and refuses every scoped credential', async () => {
    const teamId = await team(true);
    principal = { ...OWNER, role: 'viewer' };
    const viewer = await run(teamId, { prompt: 'x' });
    expect(viewer.status).toBe(403);
    principal = {
      ...OWNER,
      scope: { kind: 'session', id: '88888888-8888-4888-8888-888888888888' },
    };
    const scoped = await run(teamId, { prompt: 'x' });
    expect([scoped.status, await codeOf(scoped)]).toEqual([403, 'token_out_of_scope']);
    const anonymous = await POST(
      new NextRequest(`http://web.test/api/agent-teams/${teamId}/runs`, { method: 'POST' }),
      { params: Promise.resolve({ id: teamId }) },
    );
    expect(anonymous.status).toBe(401);
    expect(launched).toEqual([]);
  });
});
