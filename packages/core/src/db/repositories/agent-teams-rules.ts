/**
 * The agent-team repository's rules that need no scope: member checks and name resolution, row to
 * record mapping, and the database violations that read as outcomes.
 */
import { isUuid } from '@indx-workspace/contracts';
import {
  AGENT_TEAM_MEMBERS_MAX,
  defaultAgentTeamMemberName,
  isAgentTeamMemberName,
} from '@indx-workspace/contracts/agent-teams';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';

import { type AgentTeamVersionRow } from '../schema/agent-team-versions.js';
import { agentTeams, type AgentTeam } from '../schema/agent-teams.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import type {
  AgentTeamMemberInvalid,
  AgentTeamMemberProblem,
  AgentTeamMemberRecord,
  AgentTeamPinRecord,
  AgentTeamRecord,
  AgentTeamVersionRecord,
  CreateAgentTeamOutcome,
  NewAgentTeamVersionInput,
  Transaction,
} from './agent-teams-model.js';
import { postgresViolations } from './violations.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** Thrown inside a transaction to roll it back with an outcome. */
export class Rollback extends Error {
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
export function shapeProblem(
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
export async function pinnedAgentNames(
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
export function resolveMembers(
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

export function toVersionRecord(
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

export function toTeamRecord(
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
export function teamInsertFailure(error: unknown): CreateAgentTeamOutcome | null {
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
export function versionInsertFailure(error: unknown): AgentTeamMemberInvalid | null {
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

/** What every query of one scoped repository needs. */
export interface TeamScope {
  readonly db: Database;
  readonly workspaceId: string;
  /** This workspace's teams that are not deleted. */
  readonly live: SQL;
  /** The live team with this id. */
  liveTeam(id: string): SQL;
}

export type NotFound = { readonly kind: 'not-found' };

export function buildTeamScope(db: Database, workspaceId: string): TeamScope {
  const live = and(eq(agentTeams.workspaceId, workspaceId), isNull(agentTeams.deletedAt));
  if (live === undefined) throw new Error('the agent team predicate could not be built');
  const liveTeam = (id: string): SQL => {
    const predicate = and(live, eq(agentTeams.id, id));
    if (predicate === undefined) throw new Error('the agent team predicate could not be built');
    return predicate;
  };
  return { db, workspaceId, live, liveTeam };
}
