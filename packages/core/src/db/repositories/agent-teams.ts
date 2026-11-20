/**
 * The agent-team repository (ADR-0104 acceptance; issue #1516; spec 04 §5.18): a workspace's
 * agent teams and their immutable versions, scoped like every other provider here.
 *
 * A version is written in one transaction with its members, while the team row is locked, so its
 * number is the team's next and two concurrent saves are numbered one after the other. Before the
 * insert, every pin is checked to be a version of that agent in this workspace, the lead is checked
 * not to be a member, and each member's name is resolved (its agent's name when the request names
 * none). The tenant-paired foreign keys refuse the same rows again if a check is ever skipped.
 *
 * Outcomes are values, never thrown database errors: a caller maps them to problem codes, and no
 * SQL text or constraint name leaves this module.
 */
import { isUuid } from '@indx-workspace/contracts';
import { AGENT_TEAM_LIST_MAX_LIMIT } from '@indx-workspace/contracts/agent-teams';
import { and, asc, desc, eq, inArray, lt, max, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentTeamVersionMembers } from '../schema/agent-team-version-members.js';
import { agentTeamVersions, type AgentTeamVersionRow } from '../schema/agent-team-versions.js';
import { agentTeams, type AgentTeam } from '../schema/agent-teams.js';
import type {
  AgentTeamListInput,
  AgentTeamMemberInvalid,
  AgentTeamMemberRecord,
  AgentTeamRecord,
  AgentTeamRepository,
  AgentTeamRepositoryProvider,
  AgentTeamVersionListInput,
  AgentTeamVersionPage,
  AgentTeamVersionRecord,
  CreateAgentTeamOutcome,
  CreateAgentTeamVersionOutcome,
  NewAgentTeamInput,
  NewAgentTeamVersionInput,
  Reader,
  Transaction,
} from './agent-teams-model.js';
import {
  Rollback,
  buildTeamScope,
  pinnedAgentNames,
  resolveMembers,
  shapeProblem,
  teamInsertFailure,
  toTeamRecord,
  toVersionRecord,
  versionInsertFailure,
  type NotFound,
  type TeamScope,
} from './agent-teams-rules.js';
import {
  afterPosition,
  assertPageLimit,
  keysetTimestamp,
  toKeysetPage,
  type KeysetPage,
} from './keyset.js';
import { requireWorkspaceScope } from './scope.js';

export type {
  AgentTeamPinRecord,
  AgentTeamRepository,
  AgentTeamRepositoryProvider,
} from './agent-teams-model.js';

async function membersOf(
  scope: TeamScope,
  executor: Reader,
  versionIds: readonly string[],
): Promise<Map<string, AgentTeamMemberRecord[]>> {
  const byVersion = new Map<string, AgentTeamMemberRecord[]>();
  if (versionIds.length === 0) return byVersion;
  const rows = await executor
    .select()
    .from(agentTeamVersionMembers)
    .where(
      and(
        eq(agentTeamVersionMembers.workspaceId, scope.workspaceId),
        inArray(agentTeamVersionMembers.teamVersionId, [...versionIds]),
      ),
    )
    .orderBy(asc(agentTeamVersionMembers.name));
  for (const row of rows) {
    const list = byVersion.get(row.teamVersionId) ?? [];
    list.push({ name: row.name, agentId: row.agentId, agentVersionId: row.agentVersionId });
    byVersion.set(row.teamVersionId, list);
  }
  return byVersion;
}

async function withMembers(
  scope: TeamScope,
  executor: Reader,
  rows: readonly AgentTeamVersionRow[],
): Promise<AgentTeamVersionRecord[]> {
  const members = await membersOf(
    scope,
    executor,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toVersionRecord(row, members.get(row.id) ?? []));
}

/** The newest version of each of `teamIds`, by team id. */
async function latestOf(
  scope: TeamScope,
  executor: Reader,
  teamIds: readonly string[],
): Promise<Map<string, AgentTeamVersionRecord>> {
  if (teamIds.length === 0) return new Map();
  const rows = await executor
    .selectDistinctOn([agentTeamVersions.teamId])
    .from(agentTeamVersions)
    .where(
      and(
        eq(agentTeamVersions.workspaceId, scope.workspaceId),
        inArray(agentTeamVersions.teamId, [...teamIds]),
      ),
    )
    .orderBy(agentTeamVersions.teamId, desc(agentTeamVersions.number));
  const versions = await withMembers(scope, executor, rows);
  return new Map(versions.map((version) => [version.teamId, version]));
}

async function hydrate(scope: TeamScope, rows: readonly AgentTeam[]): Promise<AgentTeamRecord[]> {
  const latest = await latestOf(
    scope,
    scope.db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toTeamRecord(row, latest.get(row.id) ?? null));
}

/** The number the next version of `teamId` takes. */
async function nextVersionNumber(
  tx: Transaction,
  workspaceId: string,
  teamId: string,
): Promise<number> {
  const current = await tx
    .select({ value: max(agentTeamVersions.number) })
    .from(agentTeamVersions)
    .where(
      and(eq(agentTeamVersions.workspaceId, workspaceId), eq(agentTeamVersions.teamId, teamId)),
    );
  return (current[0]?.value ?? 0) + 1;
}

/** Insert the next version of a team the caller has locked. Throws {@link Rollback}. */
async function insertVersion(
  scope: TeamScope,
  tx: Transaction,
  teamId: string,
  input: NewAgentTeamVersionInput,
): Promise<AgentTeamVersionRecord> {
  const { workspaceId } = scope;
  const shape = shapeProblem(input);
  if (shape !== null) throw new Rollback(shape);
  const names = await pinnedAgentNames(tx, workspaceId, [input.lead, ...input.members]);
  const members = resolveMembers(input, names);
  if (!Array.isArray(members)) throw new Rollback(members);
  const inserted = await tx
    .insert(agentTeamVersions)
    .values({
      workspaceId,
      teamId,
      number: await nextVersionNumber(tx, workspaceId, teamId),
      mode: 'handoff',
      leadAgentId: input.lead.agentId,
      leadAgentVersionId: input.lead.agentVersionId,
      createdBy: input.createdBy,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new Error('agent team version insert returned no row');
  await tx
    .insert(agentTeamVersionMembers)
    .values(members.map((member) => ({ ...member, teamVersionId: row.id, workspaceId })));
  return toVersionRecord(row, members);
}

/** Run `work` and turn a {@link Rollback} or a known violation into its outcome. */
async function settle<T>(
  work: () => Promise<T>,
  known: (error: unknown) => T | null,
): Promise<T | AgentTeamMemberInvalid | NotFound> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Rollback) return error.outcome;
    const outcome = known(error) ?? versionInsertFailure(error);
    if (outcome !== null) return outcome;
    throw error;
  }
}

async function createTeam(
  scope: TeamScope,
  input: NewAgentTeamInput,
): Promise<CreateAgentTeamOutcome> {
  const outcome = await settle<CreateAgentTeamOutcome>(
    () =>
      scope.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(agentTeams)
          .values({
            workspaceId: scope.workspaceId,
            name: input.name,
            description: input.description ?? null,
            ownerPrincipalId: input.ownerPrincipalId,
            createdBy: input.createdBy,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) throw new Error('agent team insert returned no row');
        const version =
          input.version === undefined
            ? null
            : await insertVersion(scope, tx, row.id, {
                ...input.version,
                createdBy: input.createdBy,
              });
        return { kind: 'created', team: toTeamRecord(row, version) } as const;
      }),
    teamInsertFailure,
  );
  // A new team has no id another caller could name, so `not-found` cannot arise here.
  if (outcome.kind === 'not-found') throw new Error('a new agent team was not found');
  return outcome;
}

async function firstTeam(scope: TeamScope, where: SQL): Promise<AgentTeamRecord | null> {
  const rows = await scope.db.select().from(agentTeams).where(where).limit(1);
  const [team] = await hydrate(scope, rows);
  return team ?? null;
}

async function listTeams(
  scope: TeamScope,
  input: AgentTeamListInput,
): Promise<KeysetPage<AgentTeamRecord>> {
  if (input.limit !== undefined) {
    assertPageLimit(input.limit, AGENT_TEAM_LIST_MAX_LIMIT, 'agent team list');
  }
  const predicates: SQL[] = [scope.live];
  if (input.cursor !== undefined && input.cursor !== null) {
    predicates.push(afterPosition(agentTeams.createdAt, agentTeams.id, input.cursor));
  }
  const query = scope.db
    .select({ team: agentTeams, cursorAt: keysetTimestamp(agentTeams.createdAt) })
    .from(agentTeams)
    .where(and(...predicates))
    .orderBy(desc(agentTeams.createdAt), desc(agentTeams.id));
  const rows = await (input.limit === undefined ? query : query.limit(input.limit + 1));
  const page = toKeysetPage(rows, input.limit, (row) => row.team);
  return { items: await hydrate(scope, page.items), nextCursor: page.nextCursor };
}

async function softDeleteTeam(scope: TeamScope, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const removed = await scope.db
    .update(agentTeams)
    .set({ deletedAt: new Date() })
    .where(scope.liveTeam(id))
    .returning({ id: agentTeams.id });
  return removed.length > 0;
}

function createTeamVersion(
  scope: TeamScope,
  teamId: string,
  input: NewAgentTeamVersionInput,
): Promise<CreateAgentTeamVersionOutcome> {
  if (!isUuid(teamId)) return Promise.resolve({ kind: 'not-found' });
  return settle<CreateAgentTeamVersionOutcome>(
    () =>
      scope.db.transaction(async (tx) => {
        // The team row's lock serialises version numbering: a second save waits here and
        // then reads the first one's number.
        const locked = await tx
          .select({ id: agentTeams.id })
          .from(agentTeams)
          .where(scope.liveTeam(teamId))
          .for('update');
        if (locked[0] === undefined) throw new Rollback({ kind: 'not-found' });
        const version = await insertVersion(scope, tx, teamId, input);
        await tx.update(agentTeams).set({ updatedAt: new Date() }).where(scope.liveTeam(teamId));
        return { kind: 'created', version } as const;
      }),
    () => null,
  );
}

async function listTeamVersions(
  scope: TeamScope,
  teamId: string,
  input: AgentTeamVersionListInput,
): Promise<AgentTeamVersionPage | null> {
  const { db, workspaceId } = scope;
  if (input.limit !== undefined) {
    assertPageLimit(input.limit, AGENT_TEAM_LIST_MAX_LIMIT, 'agent team version list');
  }
  if (!isUuid(teamId)) return null;
  const team = await db
    .select({ id: agentTeams.id })
    .from(agentTeams)
    .where(scope.liveTeam(teamId));
  if (team[0] === undefined) return null;
  const predicates: SQL[] = [
    eq(agentTeamVersions.workspaceId, workspaceId),
    eq(agentTeamVersions.teamId, teamId),
  ];
  if (input.cursor !== undefined && input.cursor !== null) {
    predicates.push(lt(agentTeamVersions.number, input.cursor));
  }
  const query = db
    .select()
    .from(agentTeamVersions)
    .where(and(...predicates))
    .orderBy(desc(agentTeamVersions.number));
  const rows = await (input.limit === undefined ? query : query.limit(input.limit + 1));
  const hasMore = input.limit !== undefined && rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const items = await withMembers(scope, db, page);
  return { items, nextCursor: hasMore ? (page[page.length - 1]?.number ?? null) : null };
}

async function getTeamVersion(
  scope: TeamScope,
  versionId: string,
): Promise<AgentTeamVersionRecord | null> {
  if (!isUuid(versionId)) return null;
  const rows = await scope.db
    .select()
    .from(agentTeamVersions)
    .where(
      and(
        eq(agentTeamVersions.workspaceId, scope.workspaceId),
        eq(agentTeamVersions.id, versionId),
      ),
    )
    .limit(1);
  const [version] = await withMembers(scope, scope.db, rows);
  return version ?? null;
}

function repositoryFor(scope: TeamScope): AgentTeamRepository {
  const repository: AgentTeamRepository = {
    create: (input) => createTeam(scope, input),
    async get(id) {
      if (!isUuid(id)) return null;
      return firstTeam(scope, scope.liveTeam(id));
    },
    async getByName(name) {
      const where = and(scope.live, eq(agentTeams.name, name));
      if (where === undefined) throw new Error('the agent team predicate could not be built');
      return firstTeam(scope, where);
    },
    list: (input = {}) => listTeams(scope, input),
    softDelete: (id) => softDeleteTeam(scope, id),
    createVersion: (teamId, input) => createTeamVersion(scope, teamId, input),
    listVersions: (teamId, input = {}) => listTeamVersions(scope, teamId, input),
    getVersion: (versionId) => getTeamVersion(scope, versionId),
    async latestVersion(teamId) {
      if (!isUuid(teamId)) return null;
      const team = await repository.get(teamId);
      return team?.latestVersion ?? null;
    },
  };
  return repository;
}

/** The PostgreSQL {@link AgentTeamRepositoryProvider}. */
export function createDatabaseAgentTeamRepositoryProvider(
  db: Database,
): AgentTeamRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'AgentTeamRepositoryProvider');
      return repositoryFor(buildTeamScope(db, workspaceId));
    },
  };
}
