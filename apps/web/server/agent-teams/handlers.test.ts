/**
 * `/api/agent-teams/**` (ADR-0104 acceptance, issue #1516, spec 04 §5.18) driven through the real
 * Next.js route modules and the real `decide()`: the happy paths, the problem codes, the `agents`
 * RBAC the routes reuse, the uniform 404 for another workspace's team and the audit row of every
 * write. The repository is in memory; its SQL is covered by core's `agent-teams.test.ts`.
 */
import { randomUUID } from 'node:crypto';

import {
  AgentTeamListResponseSchema,
  AgentTeamResourceSchema,
  AgentTeamVersionListResponseSchema,
  AgentTeamVersionSchema,
} from '@indx-workspace/contracts/agent-teams';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, GET as READ } from '../../app/api/agent-teams/[id]/route';
import {
  GET as LIST_VERSIONS,
  POST as CREATE_VERSION,
} from '../../app/api/agent-teams/[id]/versions/route';
import { GET as LIST, POST as CREATE } from '../../app/api/agent-teams/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { installRbacHarness, type RbacHarness } from '../rbac/testing';
import { createInMemoryAgentTeamsRuntime } from './memory-store';

const owner = { email: 'owner@example.com' };
const builder = { email: 'builder@example.com' };
const otherBuilder = { email: 'other-builder@example.com' };
const viewer = { email: 'viewer@example.com' };
const OTHER_WORKSPACE = '99999999-9999-4999-8999-999999999999';
/** A UUID, as every workspace id is, because the team resource's `workspaceId` is one. */
const TEST_WORKSPACE_ID = '77777777-7777-4777-8777-777777777777';

/** Agents and versions of the test workspace, and one of another workspace. */
const LEAD = {
  agentId: '10000000-0000-4000-8000-000000000001',
  agentVersionId: '10000000-0000-4000-8000-0000000000a1',
};
const RESEARCHER = {
  agentId: '10000000-0000-4000-8000-000000000002',
  agentVersionId: '10000000-0000-4000-8000-0000000000a2',
};
const WRITER = {
  agentId: '10000000-0000-4000-8000-000000000003',
  agentVersionId: '10000000-0000-4000-8000-0000000000a3',
};
const FOREIGN = {
  agentId: '10000000-0000-4000-8000-000000000004',
  agentVersionId: '10000000-0000-4000-8000-0000000000a4',
};
const AGENTS = new Map([
  [`${TEST_WORKSPACE_ID}:${LEAD.agentVersionId}`, { ...LEAD, name: 'lead' }],
  [`${TEST_WORKSPACE_ID}:${RESEARCHER.agentVersionId}`, { ...RESEARCHER, name: 'researcher' }],
  [`${TEST_WORKSPACE_ID}:${WRITER.agentVersionId}`, { ...WRITER, name: 'Writer Agent' }],
  [`${OTHER_WORKSPACE}:${FOREIGN.agentVersionId}`, { ...FOREIGN, name: 'foreign' }],
]);

let harness: RbacHarness;
let runtime: ReturnType<typeof createInMemoryAgentTeamsRuntime>;

beforeEach(() => {
  harness = installRbacHarness(
    [
      { email: owner.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
      { email: builder.email, name: 'Builder', workspaceId: TEST_WORKSPACE_ID, role: 'builder' },
      { email: otherBuilder.email, name: 'Other', workspaceId: TEST_WORKSPACE_ID, role: 'builder' },
      { email: viewer.email, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
    ],
    { workspaceId: TEST_WORKSPACE_ID, newId: () => randomUUID() },
  );
  runtime = createInMemoryAgentTeamsRuntime({
    lookup: (workspaceId, agentId, agentVersionId) => {
      const found = AGENTS.get(`${workspaceId}:${agentVersionId}`);
      return found?.agentId === agentId ? found.name : null;
    },
  });
  installTestDomains({ agentTeams: runtime });
});

afterEach(() => {
  clearApplicationContext();
  harness.teardown();
});

type Caller = { email: string } | null;
const createAs = (as: Caller, body: unknown) =>
  harness.call(CREATE, { method: 'POST', path: '/api/agent-teams', as, body });
const listAs = (as: Caller, query = '') =>
  harness.call(LIST, { method: 'GET', path: `/api/agent-teams${query}`, as });
const readAs = (as: Caller, id: string) =>
  harness.call(READ, { method: 'GET', path: `/api/agent-teams/${id}`, as, id });
const deleteAs = (as: Caller, id: string) =>
  harness.call(DELETE, { method: 'DELETE', path: `/api/agent-teams/${id}`, as, id });
const versionAs = (as: Caller, id: string, body: unknown) =>
  harness.call(CREATE_VERSION, {
    method: 'POST',
    path: `/api/agent-teams/${id}/versions`,
    as,
    id,
    body,
  });
const versionsAs = (as: Caller, id: string, query = '') =>
  harness.call(LIST_VERSIONS, {
    method: 'GET',
    path: `/api/agent-teams/${id}/versions${query}`,
    as,
    id,
  });

const errorCode = (body: unknown): unknown => (body as { error?: { code?: unknown } }).error?.code;

const VERSION = { lead: LEAD, members: [RESEARCHER, { ...WRITER, name: 'writer' }] };

/** Create a team, with {@link VERSION} as version 1 unless `version` is `'none'`. */
async function createdTeam(as: Caller, name = 'Research', version: unknown = VERSION) {
  const created = await createAs(as, version === 'none' ? { name } : { name, version });
  expect(created.status).toBe(201);
  return AgentTeamResourceSchema.parse(created.body);
}

describe('the happy paths', () => {
  it('creates a team with version 1, reads it, and lists it', async () => {
    const team = await createdTeam(owner);
    expect(team).toMatchObject({ name: 'Research', workspaceId: TEST_WORKSPACE_ID });
    expect(team.latestVersion).toMatchObject({
      version: 1,
      mode: 'handoff',
      lead: LEAD,
      members: [
        { name: 'researcher', ...RESEARCHER },
        { name: 'writer', ...WRITER },
      ],
    });

    const read = await readAs(owner, team.id);
    expect(read.status).toBe(200);
    expect(AgentTeamResourceSchema.parse(read.body)).toEqual(team);

    const list = await listAs(viewer);
    expect(list.status).toBe(200);
    expect(AgentTeamListResponseSchema.parse(list.body)).toEqual({
      items: [team],
      nextCursor: null,
    });
  });

  it('creates a team without a version, then saves versions 1 and 2 and lists them newest first', async () => {
    const team = await createdTeam(builder, 'Empty', 'none');
    expect(team.latestVersion).toBeNull();

    const first = await versionAs(builder, team.id, VERSION);
    expect(first.status).toBe(201);
    expect(AgentTeamVersionSchema.parse(first.body).version).toBe(1);
    const second = await versionAs(builder, team.id, { lead: LEAD, members: [RESEARCHER] });
    expect(AgentTeamVersionSchema.parse(second.body).version).toBe(2);

    const page = await versionsAs(viewer, team.id, '?limit=1');
    expect(page.status).toBe(200);
    const parsed = AgentTeamVersionListResponseSchema.parse(page.body);
    expect(parsed.items.map((item) => item.version)).toEqual([2]);
    expect(parsed.nextCursor).not.toBeNull();
    const rest = AgentTeamVersionListResponseSchema.parse(
      (await versionsAs(viewer, team.id, `?cursor=${String(parsed.nextCursor)}`)).body,
    );
    expect(rest).toMatchObject({ items: [{ version: 1 }], nextCursor: null });
    expect(
      AgentTeamResourceSchema.parse((await readAs(owner, team.id)).body).latestVersion?.version,
    ).toBe(2);
  });

  it('pages the team list with a cursor bound to this list and workspace', async () => {
    await createdTeam(owner, 'One');
    await createdTeam(owner, 'Two');
    const first = AgentTeamListResponseSchema.parse((await listAs(owner, '?limit=1')).body);
    expect(first.items.map((team) => team.name)).toEqual(['Two']);
    const cursor = first.nextCursor ?? '';
    const second = AgentTeamListResponseSchema.parse(
      (await listAs(owner, `?limit=1&cursor=${encodeURIComponent(cursor)}`)).body,
    );
    expect(second).toMatchObject({ items: [{ name: 'One' }], nextCursor: null });
  });

  it('deletes a team (204), after which it is not found and its name is free', async () => {
    const team = await createdTeam(owner);
    const removed = await deleteAs(owner, team.id);
    expect(removed.status).toBe(204);
    expect((await readAs(owner, team.id)).status).toBe(404);
    expect(errorCode((await readAs(owner, team.id)).body)).toBe('agent_team_not_found');
    await createdTeam(owner);
  });

  it('audits every write as an agent change naming the team', async () => {
    const team = await createdTeam(builder);
    await versionAs(builder, team.id, VERSION);
    await deleteAs(builder, team.id);
    expect(runtime.audit.map((row) => [row.action, row.subjectId, row.subjectLabel])).toEqual([
      ['agent-changed', team.id, 'agent team Research: created'],
      ['agent-changed', team.id, 'agent team Research: version 2 saved'],
      ['agent-changed', team.id, 'agent team Research: deleted'],
    ]);
    expect(runtime.audit.every((row) => row.workspaceId === TEST_WORKSPACE_ID)).toBe(true);
  });
});

describe('the problem codes', () => {
  it('answers 409 agent_team_name_taken for a second live team of that name', async () => {
    await createdTeam(owner);
    const again = await createAs(owner, { name: 'Research' });
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('agent_team_name_taken');
  });

  it("answers 422 agent_team_member_invalid for another workspace's agent, an unknown version and a listed lead", async () => {
    const team = await createdTeam(owner, 'Checks', 'none');
    const refusals = [
      { lead: LEAD, members: [FOREIGN] },
      { lead: LEAD, members: [{ ...RESEARCHER, agentVersionId: WRITER.agentVersionId }] },
      { lead: LEAD, members: [RESEARCHER, LEAD] },
      { lead: FOREIGN, members: [RESEARCHER] },
      // `Writer Agent` is no slug, so the member needs a name of its own.
      { lead: LEAD, members: [WRITER] },
    ];
    for (const body of refusals) {
      const refused = await versionAs(owner, team.id, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(errorCode(refused.body)).toBe('agent_team_member_invalid');
    }
    const atCreate = await createAs(owner, {
      name: 'Bad',
      version: { lead: LEAD, members: [FOREIGN] },
    });
    expect(atCreate.status).toBe(422);
    expect(errorCode(atCreate.body)).toBe('agent_team_member_invalid');
    expect((await listAs(owner)).body).toMatchObject({ items: [{ name: 'Checks' }] });
  });

  it("answers 404 agent_team_not_found for another workspace's team on every :id route", async () => {
    const theirs = await (
      await runtime.repository(OTHER_WORKSPACE)
    ).create({
      name: 'Theirs',
      ownerPrincipalId: '88888888-8888-4888-8888-888888888888',
      createdBy: null,
    });
    if (theirs.kind !== 'created') throw new Error('the foreign team was not created');
    const id = theirs.team.id;
    for (const answer of [
      await readAs(owner, id),
      await deleteAs(owner, id),
      await versionAs(owner, id, VERSION),
      await versionsAs(owner, id),
    ]) {
      expect(answer.status).toBe(404);
      expect(errorCode(answer.body)).toBe('agent_team_not_found');
    }
    expect((await listAs(owner)).body).toMatchObject({ items: [] });
  });

  it('answers 400 invalid_agent_team_id for an id that is not a UUID', async () => {
    const answer = await readAs(owner, 'not-a-team');
    expect(answer.status).toBe(400);
    expect(errorCode(answer.body)).toBe('invalid_agent_team_id');
  });

  it('answers 400 invalid_body for an unknown key and a blank name, and invalid_query for a bad page', async () => {
    for (const body of [{ name: 'X', extra: true }, { name: '   ' }, {}]) {
      const refused = await createAs(owner, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(refused.body)).toBe('invalid_body');
    }
    const team = await createdTeam(owner);
    for (const body of [{ ...VERSION, mode: 'switcher' }, { members: VERSION.members }, {}]) {
      const malformed = await versionAs(owner, team.id, body);
      expect(malformed.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(malformed.body)).toBe('invalid_body');
    }
    for (const query of ['?limit=0', '?limit=201', '?cursor=forged', '?sort=name']) {
      const refused = await listAs(owner, query);
      expect(refused.status, query).toBe(400);
      expect(errorCode(refused.body)).toBe('invalid_query');
    }
    const forged = await versionsAs(owner, team.id, `?cursor=v1.${OTHER_WORKSPACE}.2`);
    expect(errorCode(forged.body)).toBe('invalid_query');
  });
});

describe('the agents RBAC the routes reuse (ADR-0104 acceptance decision 10)', () => {
  it('refuses a Viewer every write with 403, and lets it read', async () => {
    const team = await createdTeam(owner);
    for (const answer of [
      await createAs(viewer, { name: 'Viewer team' }),
      await deleteAs(viewer, team.id),
      await versionAs(viewer, team.id, VERSION),
    ]) {
      expect(answer.status).toBe(403);
      expect(errorCode(answer.body)).toBe('forbidden');
    }
    expect((await readAs(viewer, team.id)).status).toBe(200);
    expect((await versionsAs(viewer, team.id)).status).toBe(200);
  });

  it("lets a Builder write its own teams and not another Builder's, which an Owner may", async () => {
    const mine = await createdTeam(builder);
    expect((await readAs(otherBuilder, mine.id)).status).toBe(200);
    expect((await versionAs(otherBuilder, mine.id, VERSION)).status).toBe(403);
    expect((await deleteAs(otherBuilder, mine.id)).status).toBe(403);
    expect((await versionAs(builder, mine.id, VERSION)).status).toBe(201);
    expect((await deleteAs(owner, mine.id)).status).toBe(204);
  });

  it('answers 401 to a caller with no identity', async () => {
    expect((await listAs(null)).status).toBe(401);
    expect((await createAs(null, { name: 'Nobody' })).status).toBe(401);
  });
});
