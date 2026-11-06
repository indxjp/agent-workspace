/**
 * The agent-team repository against a real PostgreSQL (ADR-0104 acceptance; issue #1516):
 * workspace scoping, the member checks a version write makes, sequential version numbers under
 * concurrent saves, the soft delete and the name rule among live teams.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentTeamVersionMembers } from '../schema/agent-team-version-members.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseAgentTeamRepositoryProvider,
  type AgentTeamPinRecord,
  type AgentTeamRepository,
} from './agent-teams.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/agent-teams.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

interface Tenant {
  readonly workspaceId: string;
  readonly userId: string;
  readonly principalId: string;
  readonly teams: AgentTeamRepository;
}

describe.skipIf(!hasDatabase)('AgentTeamRepository (ADR-0104 acceptance)', () => {
  let isolated: IsolatedTestDatabase;
  let mine: Tenant;
  let theirs: Tenant;

  async function seedTenant(): Promise<Tenant> {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const { db } = isolated;
    await db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Teams' });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('fixture workspace did not resolve');
    return {
      workspaceId,
      userId,
      principalId,
      teams: createDatabaseAgentTeamRepositoryProvider(db).forScope(scope),
    };
  }

  /** An agent of `owner` with one saved version, pinned. */
  async function agentPin(owner: Tenant, name: string): Promise<AgentTeamPinRecord> {
    const agentId = crypto.randomUUID();
    const agentVersionId = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId: owner.workspaceId,
      name: `${name}-${agentId.slice(0, 8)}`,
      instructions: '',
      ownerPrincipalId: owner.principalId,
      createdBy: owner.userId,
      permissions: PERMISSIONS,
    });
    await isolated.db.insert(agentVersions).values({
      id: agentVersionId,
      workspaceId: owner.workspaceId,
      agentId,
      number: 1,
      summary: 'first',
      via: 'api',
      body: {},
      createdByPrincipalId: owner.principalId,
    });
    return { agentId, agentVersionId };
  }

  function teamInput(owner: Tenant, name: string) {
    return { name, ownerPrincipalId: owner.principalId, createdBy: owner.userId };
  }

  async function newTeam(owner: Tenant, name: string): Promise<string> {
    const created = await owner.teams.create(teamInput(owner, name));
    if (created.kind !== 'created') throw new Error(`team create failed: ${created.kind}`);
    return created.team.id;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_agent_teams');
    mine = await seedTenant();
    theirs = await seedTenant();
  }, 180_000);

  afterAll(async () => isolated.close());

  it('creates a team with its first version, pinning the lead and the members', async () => {
    const lead = await agentPin(mine, 'lead');
    const researcher = await agentPin(mine, 'researcher');
    const writer = await agentPin(mine, 'writer');
    const created = await mine.teams.create({
      ...teamInput(mine, 'Support'),
      description: 'Answers tickets',
      version: {
        lead,
        members: [
          { ...writer, name: 'writer' },
          { ...researcher, name: 'researcher' },
        ],
      },
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const { team } = created;
    expect(team).toMatchObject({
      workspaceId: mine.workspaceId,
      name: 'Support',
      description: 'Answers tickets',
      ownerPrincipalId: mine.principalId,
      createdBy: mine.userId,
    });
    expect(team.latestVersion).toMatchObject({
      number: 1,
      mode: 'handoff',
      lead,
      members: [
        { name: 'researcher', ...researcher },
        { name: 'writer', ...writer },
      ],
    });
    await expect(mine.teams.get(team.id)).resolves.toEqual(team);
    await expect(mine.teams.getByName('Support')).resolves.toEqual(team);
    await expect(mine.teams.latestVersion(team.id)).resolves.toEqual(team.latestVersion);
  });

  it("defaults a member's name to its agent's name, and refuses one that is not a slug", async () => {
    const teamId = await newTeam(mine, 'Defaults');
    const lead = await agentPin(mine, 'lead');
    const member = await agentPin(mine, 'helper');
    const saved = await mine.teams.createVersion(teamId, {
      lead,
      members: [member],
      createdBy: null,
    });
    expect(saved.kind).toBe('created');
    if (saved.kind !== 'created') return;
    expect(saved.version.members[0]?.name).toBe(`helper-${member.agentId.slice(0, 8)}`);

    const agentId = crypto.randomUUID();
    const agentVersionId = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId: mine.workspaceId,
      name: 'Not A Slug',
      instructions: '',
      ownerPrincipalId: mine.principalId,
      permissions: PERMISSIONS,
    });
    await isolated.db.insert(agentVersions).values({
      id: agentVersionId,
      workspaceId: mine.workspaceId,
      agentId,
      number: 1,
      summary: 'first',
      via: 'api',
      body: {},
      createdByPrincipalId: mine.principalId,
    });
    await expect(
      mine.teams.createVersion(teamId, {
        lead,
        members: [{ agentId, agentVersionId }],
        createdBy: null,
      }),
    ).resolves.toEqual({ kind: 'member-invalid', problem: 'member-name-invalid', agentId });
  });

  it('refuses a member from another workspace, and saves nothing', async () => {
    const teamId = await newTeam(mine, 'Cross tenant');
    const lead = await agentPin(mine, 'lead');
    const foreign = await agentPin(theirs, 'foreign');
    await expect(
      mine.teams.createVersion(teamId, { lead, members: [foreign], createdBy: null }),
    ).resolves.toEqual({
      kind: 'member-invalid',
      problem: 'unknown-version',
      agentId: foreign.agentId,
    });
    await expect(mine.teams.latestVersion(teamId)).resolves.toBeNull();
  });

  it('refuses an unknown version, and a version of a different agent', async () => {
    const teamId = await newTeam(mine, 'Unknown version');
    const lead = await agentPin(mine, 'lead');
    const member = await agentPin(mine, 'member');
    const other = await agentPin(mine, 'other');
    for (const pin of [
      { agentId: member.agentId, agentVersionId: crypto.randomUUID() },
      { agentId: member.agentId, agentVersionId: other.agentVersionId },
    ]) {
      await expect(
        mine.teams.createVersion(teamId, { lead, members: [pin], createdBy: null }),
      ).resolves.toEqual({
        kind: 'member-invalid',
        problem: 'unknown-version',
        agentId: member.agentId,
      });
    }
    await expect(
      mine.teams.createVersion(teamId, {
        lead: { agentId: lead.agentId, agentVersionId: crypto.randomUUID() },
        members: [member],
        createdBy: null,
      }),
    ).resolves.toEqual({
      kind: 'member-invalid',
      problem: 'unknown-version',
      agentId: lead.agentId,
    });
  });

  it('refuses the lead listed as a member, a repeated agent, and a member count outside 1–8', async () => {
    const teamId = await newTeam(mine, 'Shapes');
    const lead = await agentPin(mine, 'lead');
    const member = await agentPin(mine, 'member');
    await expect(
      mine.teams.createVersion(teamId, { lead, members: [member, lead], createdBy: null }),
    ).resolves.toEqual({
      kind: 'member-invalid',
      problem: 'lead-is-member',
      agentId: lead.agentId,
    });
    await expect(
      mine.teams.createVersion(teamId, { lead, members: [member, member], createdBy: null }),
    ).resolves.toEqual({
      kind: 'member-invalid',
      problem: 'duplicate-agent',
      agentId: member.agentId,
    });
    await expect(
      mine.teams.createVersion(teamId, { lead, members: [], createdBy: null }),
    ).resolves.toEqual({ kind: 'member-invalid', problem: 'member-count' });
    const nine = Array.from({ length: 9 }, () => ({
      agentId: crypto.randomUUID(),
      agentVersionId: crypto.randomUUID(),
    }));
    await expect(
      mine.teams.createVersion(teamId, { lead, members: nine, createdBy: null }),
    ).resolves.toEqual({ kind: 'member-invalid', problem: 'member-count' });
    const second = await agentPin(mine, 'second');
    await expect(
      mine.teams.createVersion(teamId, {
        lead,
        members: [
          { ...member, name: 'same' },
          { ...second, name: 'same' },
        ],
        createdBy: null,
      }),
    ).resolves.toEqual({
      kind: 'member-invalid',
      problem: 'member-name-repeated',
      agentId: second.agentId,
    });
  });

  it('numbers versions sequentially under two concurrent saves', async () => {
    const teamId = await newTeam(mine, 'Concurrent');
    const lead = await agentPin(mine, 'lead');
    const member = await agentPin(mine, 'member');
    const input = { lead, members: [member], createdBy: null };
    const saved = await Promise.all([
      mine.teams.createVersion(teamId, input),
      mine.teams.createVersion(teamId, input),
      mine.teams.createVersion(teamId, input),
    ]);
    const numbers = saved.map((outcome) =>
      outcome.kind === 'created' ? outcome.version.number : 0,
    );
    expect([...numbers].sort()).toEqual([1, 2, 3]);
    const page = await mine.teams.listVersions(teamId, { limit: 2 });
    expect(page?.items.map((version) => version.number)).toEqual([3, 2]);
    expect(page?.nextCursor).toBe(2);
    const rest = await mine.teams.listVersions(teamId, {
      limit: 2,
      cursor: page?.nextCursor ?? null,
    });
    expect(rest?.items.map((version) => version.number)).toEqual([1]);
    expect(rest?.nextCursor).toBeNull();
    await expect(mine.teams.latestVersion(teamId)).resolves.toMatchObject({ number: 3 });
  });

  it('isolates workspaces: another workspace cannot get, list, version or delete a team', async () => {
    const teamId = await newTeam(mine, 'Private');
    const lead = await agentPin(theirs, 'lead');
    const member = await agentPin(theirs, 'member');
    await expect(theirs.teams.get(teamId)).resolves.toBeNull();
    await expect(theirs.teams.getByName('Private')).resolves.toBeNull();
    const listed = await theirs.teams.list();
    expect(listed.items.map((team) => team.id)).not.toContain(teamId);
    await expect(
      theirs.teams.createVersion(teamId, { lead, members: [member], createdBy: null }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(theirs.teams.listVersions(teamId)).resolves.toBeNull();
    await expect(theirs.teams.softDelete(teamId)).resolves.toBe(false);
    await expect(mine.teams.get(teamId)).resolves.not.toBeNull();
  });

  it('answers agent_team_name_taken for a live duplicate, and frees the name on delete', async () => {
    const teamId = await newTeam(mine, 'Named');
    await expect(mine.teams.create(teamInput(mine, 'Named'))).resolves.toEqual({
      kind: 'name-taken',
    });
    // Another workspace may use the same name.
    await expect(theirs.teams.create(teamInput(theirs, 'Named'))).resolves.toMatchObject({
      kind: 'created',
    });
    await expect(mine.teams.softDelete(teamId)).resolves.toBe(true);
    await expect(mine.teams.softDelete(teamId)).resolves.toBe(false);
    await expect(mine.teams.get(teamId)).resolves.toBeNull();
    await expect(mine.teams.listVersions(teamId)).resolves.toBeNull();
    await expect(mine.teams.create(teamInput(mine, 'Named'))).resolves.toMatchObject({
      kind: 'created',
    });
  });

  it('lists live teams newest first with a cursor, and answers a non-UUID as absent', async () => {
    const tenant = await seedTenant();
    const ids: string[] = [];
    for (const name of ['One', 'Two', 'Three']) ids.push(await newTeam(tenant, name));
    const first = await tenant.teams.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await tenant.teams.list({ limit: 2, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((team) => team.id).sort()).toEqual(
      [...ids].sort(),
    );
    await expect(tenant.teams.get('not-a-uuid')).resolves.toBeNull();
    await expect(tenant.teams.softDelete('not-a-uuid')).resolves.toBe(false);
    await expect(
      tenant.teams.createVersion('not-a-uuid', {
        lead: { agentId: ids[0] ?? '', agentVersionId: ids[0] ?? '' },
        members: [],
        createdBy: null,
      }),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('refuses, in the database, a member row that pins another workspace’s version', async () => {
    const lead = await agentPin(mine, 'lead');
    const member = await agentPin(mine, 'member');
    const created = await mine.teams.create({
      ...teamInput(mine, 'Database check'),
      version: { lead, members: [member] },
    });
    if (created.kind !== 'created' || created.team.latestVersion === null) {
      throw new Error('fixture team was not created');
    }
    const foreign = await agentPin(theirs, 'foreign');
    let constraints: string[] = [];
    try {
      await isolated.db.insert(agentTeamVersionMembers).values({
        teamVersionId: created.team.latestVersion.id,
        workspaceId: mine.workspaceId,
        agentId: foreign.agentId,
        agentVersionId: foreign.agentVersionId,
        name: 'foreign',
      });
    } catch (error) {
      constraints = [...postgresViolations(error)].map((violation) => violation.constraint);
    }
    expect(constraints).toContain('agent_team_version_members_agent_version_fk');
    const rows = await isolated.db
      .select()
      .from(agentTeamVersionMembers)
      .where(eq(agentTeamVersionMembers.teamVersionId, created.team.latestVersion.id));
    expect(rows).toHaveLength(1);
  });
});
