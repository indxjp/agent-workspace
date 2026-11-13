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
import {
  AGENT_TEAM_LIST_MAX_LIMIT,
  AGENT_TEAM_MEMBERS_MAX,
  defaultAgentTeamMemberName,
  isAgentTeamMemberName,
  type AgentTeamMode,
} from '@indx-workspace/contracts/agent-teams';
import { and, asc, desc, eq, inArray, isNull, lt, max, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentTeamVersionMembers } from '../schema/agent-team-version-members.js';
import { agentTeamVersions, type AgentTeamVersionRow } from '../schema/agent-team-versions.js';
import { agentTeams, type AgentTeam } from '../schema/agent-teams.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import {
  afterPosition,
  assertPageLimit,
  keysetTimestamp,
  toKeysetPage,
  type KeysetPage,
  type KeysetPosition,
} from './keyset.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** What the read helpers need: the database or a transaction. */
type Reader = Pick<Transaction, 'select' | 'selectDistinctOn'>;

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** One pinned agent version. */
export interface AgentTeamPinRecord {
  readonly agentId: string;
  readonly agentVersionId: string;
}

interface AgentTeamMemberRecord extends AgentTeamPinRecord {
  readonly name: string;
}

interface AgentTeamVersionRecord {
  readonly id: string;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly number: number;
  readonly mode: AgentTeamMode;
  readonly lead: AgentTeamPinRecord;
  /** Ordered by member name. */
  readonly members: readonly AgentTeamMemberRecord[];
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

interface AgentTeamRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerPrincipalId: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The newest version, or `null` for a team that has none yet. */
  readonly latestVersion: AgentTeamVersionRecord | null;
}

/** A version to save. A member without a name takes its agent's name, when that is valid. */
interface NewAgentTeamVersionInput {
  readonly lead: AgentTeamPinRecord;
  readonly members: readonly (AgentTeamPinRecord & { readonly name?: string })[];
  /** The user saving it, or `null` for an API-key principal. */
  readonly createdBy: string | null;
}

interface NewAgentTeamInput {
  /** Already trimmed and bounded by the contract. */
  readonly name: string;
  readonly description?: string | null;
  readonly ownerPrincipalId: string;
  readonly createdBy: string | null;
  /** Saved as version 1 in the same transaction, when given. */
  readonly version?: Omit<NewAgentTeamVersionInput, 'createdBy'>;
}

/** Why a version's members were refused: each is `422 agent_team_member_invalid`. */
type AgentTeamMemberProblem =
  | 'member-count'
  | 'lead-is-member'
  | 'duplicate-agent'
  | 'unknown-version'
  | 'member-name-invalid'
  | 'member-name-repeated';

interface AgentTeamMemberInvalid {
  readonly kind: 'member-invalid';
  readonly problem: AgentTeamMemberProblem;
  /** The agent the problem is about, when it is about one. */
  readonly agentId?: string;
}

type CreateAgentTeamOutcome =
  | { readonly kind: 'created'; readonly team: AgentTeamRecord }
  | { readonly kind: 'name-taken' }
  | { readonly kind: 'unknown-principal' }
  | AgentTeamMemberInvalid;

type CreateAgentTeamVersionOutcome =
  | { readonly kind: 'created'; readonly version: AgentTeamVersionRecord }
  | { readonly kind: 'not-found' }
  | AgentTeamMemberInvalid;

interface AgentTeamListInput {
  /** 1–{@link AGENT_TEAM_LIST_MAX_LIMIT}; omitted, every remaining team in one page. */
  readonly limit?: number;
  readonly cursor?: KeysetPosition | null;
}

interface AgentTeamVersionListInput {
  /** 1–{@link AGENT_TEAM_LIST_MAX_LIMIT}; omitted, every remaining version in one page. */
  readonly limit?: number;
  /** The `nextCursor` of the previous page: versions numbered below it come next. */
  readonly cursor?: number | null;
}

/** Versions newest (highest number) first; `nextCursor` is the last number served. */
interface AgentTeamVersionPage {
  readonly items: readonly AgentTeamVersionRecord[];
  readonly nextCursor: number | null;
}

export interface AgentTeamRepository {
  /** Insert a team, and its first version when the input carries one, in one transaction. */
  create(input: NewAgentTeamInput): Promise<CreateAgentTeamOutcome>;
  /** `null` for an unknown id, another workspace's, a deleted team's, and a non-UUID string. */
  get(id: string): Promise<AgentTeamRecord | null>;
  /** The live team with this exact name, or `null`. */
  getByName(name: string): Promise<AgentTeamRecord | null>;
  /** Live teams, newest first, keyset paged (ADR-0079). */
  list(input?: AgentTeamListInput): Promise<KeysetPage<AgentTeamRecord>>;
  /** Mark a live team deleted. `false` when there is no live team with that id here. */
  softDelete(id: string): Promise<boolean>;
  /** Save the next version of a live team. */
  createVersion(
    teamId: string,
    input: NewAgentTeamVersionInput,
  ): Promise<CreateAgentTeamVersionOutcome>;
  /** A live team's versions, newest first; `null` when there is no live team with that id. */
  listVersions(
    teamId: string,
    input?: AgentTeamVersionListInput,
  ): Promise<AgentTeamVersionPage | null>;
  /** A live team's newest version; `null` when it has none or there is no such live team. */
  latestVersion(teamId: string): Promise<AgentTeamVersionRecord | null>;
  /**
   * One version by id, with its members, whether or not its team has since been deleted: a team
   * run pins its version (ADR-0104 acceptance decision 11), so a running lead keeps its members.
   * `null` for an id that is no version of this workspace.
   */
  getVersion(versionId: string): Promise<AgentTeamVersionRecord | null>;
}

export interface AgentTeamRepositoryProvider {
  forScope(scope: WorkspaceScope): AgentTeamRepository;
}

/** Thrown inside a transaction to roll it back with an outcome. */
class Rollback extends Error {
  constructor(readonly outcome: AgentTeamMemberInvalid | { readonly kind: 'not-found' }) {
    super(`agent team transaction rolled back: ${outcome.kind}`);
    this.name = 'Rollback';
  }
}

function memberInvalid(problem: AgentTeamMemberProblem, agentId?: string): AgentTeamMemberInvalid {
  return agentId === undefined
    ? { kind: 'member-invalid', problem }
    : { kind: 'member-invalid', problem, agentId };
}

/** The checks that need no database: count, the lead not a member, each agent once. */
function shapeProblem(
  input: Omit<NewAgentTeamVersionInput, 'createdBy'>,
): AgentTeamMemberInvalid | null {
  if (input.members.length < 1 || input.members.length > AGENT_TEAM_MEMBERS_MAX) {
    return memberInvalid('member-count');
  }
  const seen = new Set<string>();
  for (const member of input.members) {
    if (member.agentId === input.lead.agentId)
      return memberInvalid('lead-is-member', member.agentId);
    if (seen.has(member.agentId)) return memberInvalid('duplicate-agent', member.agentId);
    seen.add(member.agentId);
  }
  return null;
}

/**
 * The name of each pinned agent whose version exists in this workspace, by agent id. A pin of
 * another workspace's agent, of a version of a different agent, or of a non-UUID is absent.
 */
async function pinnedAgentNames(
  tx: Transaction,
  workspaceId: string,
  pins: readonly AgentTeamPinRecord[],
): Promise<Map<string, string>> {
  const versionIds = pins.map((pin) => pin.agentVersionId).filter(isUuid);
  if (versionIds.length === 0) return new Map();
  const rows = await tx
    .select({ versionId: agentVersions.id, agentId: agentVersions.agentId, name: agents.name })
    .from(agentVersions)
    .innerJoin(
      agents,
      and(eq(agents.id, agentVersions.agentId), eq(agents.workspaceId, agentVersions.workspaceId)),
    )
    .where(and(eq(agentVersions.workspaceId, workspaceId), inArray(agentVersions.id, versionIds)));
  const found = new Map<string, string>();
  for (const pin of pins) {
    const row = rows.find((r) => r.versionId === pin.agentVersionId && r.agentId === pin.agentId);
    if (row !== undefined) found.set(pin.agentId, row.name);
  }
  return found;
}

/** Resolve each member's name, or the first problem with the pins or the names. */
function resolveMembers(
  input: Omit<NewAgentTeamVersionInput, 'createdBy'>,
  names: ReadonlyMap<string, string>,
): AgentTeamMemberRecord[] | AgentTeamMemberInvalid {
  for (const pin of [input.lead, ...input.members]) {
    if (!names.has(pin.agentId)) return memberInvalid('unknown-version', pin.agentId);
  }
  const resolved: AgentTeamMemberRecord[] = [];
  const taken = new Set<string>();
  for (const member of input.members) {
    const name = member.name ?? defaultAgentTeamMemberName(names.get(member.agentId) ?? '');
    if (name === null || !isAgentTeamMemberName(name)) {
      return memberInvalid('member-name-invalid', member.agentId);
    }
    if (taken.has(name)) return memberInvalid('member-name-repeated', member.agentId);
    taken.add(name);
    resolved.push({ name, agentId: member.agentId, agentVersionId: member.agentVersionId });
  }
  return resolved;
}

function toVersionRecord(
  row: AgentTeamVersionRow,
  members: readonly AgentTeamMemberRecord[],
): AgentTeamVersionRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    number: row.number,
    mode: row.mode,
    lead: { agentId: row.leadAgentId, agentVersionId: row.leadAgentVersionId },
    members: [...members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function toTeamRecord(
  row: AgentTeam,
  latestVersion: AgentTeamVersionRecord | null,
): AgentTeamRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    ownerPrincipalId: row.ownerPrincipalId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestVersion,
  };
}

/** The outcome a failed team insert names, or `null` for an error this module does not own. */
function teamInsertFailure(error: unknown): CreateAgentTeamOutcome | null {
  for (const failure of postgresViolations(error)) {
    if (
      failure.code === UNIQUE_VIOLATION &&
      failure.constraint === 'agent_teams_workspace_name_key'
    ) {
      return { kind: 'name-taken' };
    }
    if (failure.code === FOREIGN_KEY_VIOLATION && failure.constraint.startsWith('agent_teams_')) {
      return { kind: 'unknown-principal' };
    }
  }
  return null;
}

/** A pin whose version went away between the check and the insert reads as an unknown version. */
function versionInsertFailure(error: unknown): AgentTeamMemberInvalid | null {
  for (const failure of postgresViolations(error)) {
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      (failure.constraint === 'agent_team_versions_lead_version_fk' ||
        failure.constraint === 'agent_team_version_members_agent_version_fk')
    ) {
      return memberInvalid('unknown-version');
    }
  }
  return null;
}

/** The PostgreSQL {@link AgentTeamRepositoryProvider}. */
export function createDatabaseAgentTeamRepositoryProvider(
  db: Database,
): AgentTeamRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'AgentTeamRepositoryProvider');
      const live = and(eq(agentTeams.workspaceId, workspaceId), isNull(agentTeams.deletedAt));
      if (live === undefined) throw new Error('the agent team predicate could not be built');
      const liveTeam = (id: string): SQL => {
        const predicate = and(live, eq(agentTeams.id, id));
        if (predicate === undefined) throw new Error('the agent team predicate could not be built');
        return predicate;
      };

      async function membersOf(
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
              eq(agentTeamVersionMembers.workspaceId, workspaceId),
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
        executor: Reader,
        rows: readonly AgentTeamVersionRow[],
      ): Promise<AgentTeamVersionRecord[]> {
        const members = await membersOf(
          executor,
          rows.map((row) => row.id),
        );
        return rows.map((row) => toVersionRecord(row, members.get(row.id) ?? []));
      }

      /** The newest version of each of `teamIds`, by team id. */
      async function latestOf(
        executor: Reader,
        teamIds: readonly string[],
      ): Promise<Map<string, AgentTeamVersionRecord>> {
        if (teamIds.length === 0) return new Map();
        const rows = await executor
          .selectDistinctOn([agentTeamVersions.teamId])
          .from(agentTeamVersions)
          .where(
            and(
              eq(agentTeamVersions.workspaceId, workspaceId),
              inArray(agentTeamVersions.teamId, [...teamIds]),
            ),
          )
          .orderBy(agentTeamVersions.teamId, desc(agentTeamVersions.number));
        const versions = await withMembers(executor, rows);
        return new Map(versions.map((version) => [version.teamId, version]));
      }

      async function hydrate(
        executor: Reader,
        rows: readonly AgentTeam[],
      ): Promise<AgentTeamRecord[]> {
        const latest = await latestOf(
          executor,
          rows.map((row) => row.id),
        );
        return rows.map((row) => toTeamRecord(row, latest.get(row.id) ?? null));
      }

      /** Insert the next version of a team the caller has locked. Throws {@link Rollback}. */
      async function insertVersion(
        tx: Transaction,
        teamId: string,
        input: NewAgentTeamVersionInput,
      ): Promise<AgentTeamVersionRecord> {
        const shape = shapeProblem(input);
        if (shape !== null) throw new Rollback(shape);
        const names = await pinnedAgentNames(tx, workspaceId, [input.lead, ...input.members]);
        const members = resolveMembers(input, names);
        if (!Array.isArray(members)) throw new Rollback(members);
        const current = await tx
          .select({ value: max(agentTeamVersions.number) })
          .from(agentTeamVersions)
          .where(
            and(
              eq(agentTeamVersions.workspaceId, workspaceId),
              eq(agentTeamVersions.teamId, teamId),
            ),
          );
        const inserted = await tx
          .insert(agentTeamVersions)
          .values({
            workspaceId,
            teamId,
            number: (current[0]?.value ?? 0) + 1,
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
      ): Promise<T | AgentTeamMemberInvalid | { readonly kind: 'not-found' }> {
        try {
          return await work();
        } catch (error) {
          if (error instanceof Rollback) return error.outcome;
          const outcome = known(error) ?? versionInsertFailure(error);
          if (outcome !== null) return outcome;
          throw error;
        }
      }

      const repository: AgentTeamRepository = {
        async create(input) {
          const outcome = await settle<CreateAgentTeamOutcome>(
            () =>
              db.transaction(async (tx) => {
                const inserted = await tx
                  .insert(agentTeams)
                  .values({
                    workspaceId,
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
                    : await insertVersion(tx, row.id, {
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
        },

        async get(id) {
          if (!isUuid(id)) return null;
          const rows = await db.select().from(agentTeams).where(liveTeam(id)).limit(1);
          const [team] = await hydrate(db, rows);
          return team ?? null;
        },

        async getByName(name) {
          const rows = await db
            .select()
            .from(agentTeams)
            .where(and(live, eq(agentTeams.name, name)))
            .limit(1);
          const [team] = await hydrate(db, rows);
          return team ?? null;
        },

        async list(input = {}) {
          if (input.limit !== undefined) {
            assertPageLimit(input.limit, AGENT_TEAM_LIST_MAX_LIMIT, 'agent team list');
          }
          const predicates: SQL[] = [live];
          if (input.cursor !== undefined && input.cursor !== null) {
            predicates.push(afterPosition(agentTeams.createdAt, agentTeams.id, input.cursor));
          }
          const query = db
            .select({ team: agentTeams, cursorAt: keysetTimestamp(agentTeams.createdAt) })
            .from(agentTeams)
            .where(and(...predicates))
            .orderBy(desc(agentTeams.createdAt), desc(agentTeams.id));
          const rows = await (input.limit === undefined ? query : query.limit(input.limit + 1));
          const page = toKeysetPage(rows, input.limit, (row) => row.team);
          return { items: await hydrate(db, page.items), nextCursor: page.nextCursor };
        },

        async softDelete(id) {
          if (!isUuid(id)) return false;
          const removed = await db
            .update(agentTeams)
            .set({ deletedAt: new Date() })
            .where(liveTeam(id))
            .returning({ id: agentTeams.id });
          return removed.length > 0;
        },

        createVersion(teamId, input) {
          if (!isUuid(teamId)) return Promise.resolve({ kind: 'not-found' });
          return settle<CreateAgentTeamVersionOutcome>(
            () =>
              db.transaction(async (tx) => {
                // The team row's lock serialises version numbering: a second save waits here and
                // then reads the first one's number.
                const locked = await tx
                  .select({ id: agentTeams.id })
                  .from(agentTeams)
                  .where(liveTeam(teamId))
                  .for('update');
                if (locked[0] === undefined) throw new Rollback({ kind: 'not-found' });
                const version = await insertVersion(tx, teamId, input);
                await tx.update(agentTeams).set({ updatedAt: new Date() }).where(liveTeam(teamId));
                return { kind: 'created', version } as const;
              }),
            () => null,
          );
        },

        async listVersions(teamId, input = {}) {
          if (input.limit !== undefined) {
            assertPageLimit(input.limit, AGENT_TEAM_LIST_MAX_LIMIT, 'agent team version list');
          }
          if (!isUuid(teamId)) return null;
          const team = await db
            .select({ id: agentTeams.id })
            .from(agentTeams)
            .where(liveTeam(teamId));
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
          const items = await withMembers(db, page);
          return { items, nextCursor: hasMore ? (page[page.length - 1]?.number ?? null) : null };
        },

        async getVersion(versionId) {
          if (!isUuid(versionId)) return null;
          const rows = await db
            .select()
            .from(agentTeamVersions)
            .where(
              and(
                eq(agentTeamVersions.workspaceId, workspaceId),
                eq(agentTeamVersions.id, versionId),
              ),
            )
            .limit(1);
          const [version] = await withMembers(db, rows);
          return version ?? null;
        },

        async latestVersion(teamId) {
          if (!isUuid(teamId)) return null;
          const team = await repository.get(teamId);
          return team?.latestVersion ?? null;
        },
      };
      return repository;
    },
  };
}
