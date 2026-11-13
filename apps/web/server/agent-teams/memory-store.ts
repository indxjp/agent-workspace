/**
 * Test support: an in-memory {@link AgentTeamsRuntime} with the core repository's outcomes
 * (`packages/core/src/db/repositories/agent-teams.ts`), so the routes are tested without a
 * database. The PostgreSQL behaviour itself is covered by that repository's own tests. No route or
 * production module imports it.
 */
import { randomUUID } from 'node:crypto';

import {
  AGENT_TEAM_MEMBERS_MAX,
  defaultAgentTeamMemberName,
  isAgentTeamMemberName,
} from '@indx-workspace/contracts/agent-teams';

import type {
  AgentTeamAuditEvent,
  AgentTeamMemberInvalid,
  AgentTeamRecord,
  AgentTeamRepository,
  AgentTeamsRuntime,
  AgentTeamVersionInput,
  AgentTeamVersionRecord,
} from './runtime';

/** The agent name a pin resolves to in `workspaceId`, or `null` when it is no version there. */
export type PinnedAgentLookup = (
  workspaceId: string,
  agentId: string,
  agentVersionId: string,
) => string | null;

interface StoredTeam {
  record: Omit<AgentTeamRecord, 'latestVersion'>;
  deleted: boolean;
  versions: AgentTeamVersionRecord[];
}

function invalid(problem: AgentTeamMemberInvalid['problem'], agentId?: string) {
  return agentId === undefined
    ? ({ kind: 'member-invalid', problem } as const)
    : ({ kind: 'member-invalid', problem, agentId } as const);
}

function checkVersion(
  workspaceId: string,
  input: Omit<AgentTeamVersionInput, 'createdBy'>,
  lookup: PinnedAgentLookup,
):
  | AgentTeamMemberInvalid
  | { readonly kind: 'ok'; readonly members: AgentTeamVersionRecord['members'] } {
  if (input.members.length < 1 || input.members.length > AGENT_TEAM_MEMBERS_MAX) {
    return invalid('member-count');
  }
  const seen = new Set<string>();
  for (const member of input.members) {
    if (member.agentId === input.lead.agentId) return invalid('lead-is-member', member.agentId);
    if (seen.has(member.agentId)) return invalid('duplicate-agent', member.agentId);
    seen.add(member.agentId);
  }
  for (const pin of [input.lead, ...input.members]) {
    if (lookup(workspaceId, pin.agentId, pin.agentVersionId) === null) {
      return invalid('unknown-version', pin.agentId);
    }
  }
  const taken = new Set<string>();
  const members: { name: string; agentId: string; agentVersionId: string }[] = [];
  for (const member of input.members) {
    const name =
      member.name ??
      defaultAgentTeamMemberName(lookup(workspaceId, member.agentId, member.agentVersionId) ?? '');
    if (name === null || !isAgentTeamMemberName(name)) {
      return invalid('member-name-invalid', member.agentId);
    }
    if (taken.has(name)) return invalid('member-name-repeated', member.agentId);
    taken.add(name);
    members.push({ name, agentId: member.agentId, agentVersionId: member.agentVersionId });
  }
  return {
    kind: 'ok',
    members: members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/** An in-memory runtime; `audit` collects every row a write records. */
export function createInMemoryAgentTeamsRuntime(options: {
  readonly lookup: PinnedAgentLookup;
  readonly now?: () => Date;
}): AgentTeamsRuntime & { readonly audit: AgentTeamAuditEvent[] } {
  const teams = new Map<string, StoredTeam>();
  const audit: AgentTeamAuditEvent[] = [];
  let tick = 0;
  // Strictly increasing timestamps, so newest-first order never ties.
  const now = options.now ?? ((): Date => new Date(Date.UTC(2026, 9, 31) + (tick += 1) * 1000));

  const repository = (workspaceId: string): AgentTeamRepository => {
    const live = (id: string): StoredTeam | null => {
      const team = teams.get(id);
      return team === undefined || team.deleted || team.record.workspaceId !== workspaceId
        ? null
        : team;
    };
    const view = (team: StoredTeam): AgentTeamRecord => ({
      ...team.record,
      latestVersion: team.versions.at(-1) ?? null,
    });
    const saveVersion = (
      team: StoredTeam,
      input: AgentTeamVersionInput,
    ): AgentTeamMemberInvalid | AgentTeamVersionRecord => {
      const checked = checkVersion(workspaceId, input, options.lookup);
      if (checked.kind !== 'ok') return checked;
      const { members } = checked;
      const version: AgentTeamVersionRecord = {
        id: randomUUID(),
        teamId: team.record.id,
        workspaceId,
        number: team.versions.length + 1,
        mode: 'handoff',
        lead: { agentId: input.lead.agentId, agentVersionId: input.lead.agentVersionId },
        members,
        createdBy: input.createdBy,
        createdAt: now(),
      };
      team.versions.push(version);
      return version;
    };
    return {
      create(input) {
        const taken = [...teams.values()].some(
          (team) =>
            !team.deleted &&
            team.record.workspaceId === workspaceId &&
            team.record.name === input.name,
        );
        if (taken) return Promise.resolve({ kind: 'name-taken' });
        const at = now();
        const team: StoredTeam = {
          record: {
            id: randomUUID(),
            workspaceId,
            name: input.name,
            description: input.description ?? null,
            ownerPrincipalId: input.ownerPrincipalId,
            createdBy: input.createdBy,
            createdAt: at,
            updatedAt: at,
          },
          deleted: false,
          versions: [],
        };
        if (input.version !== undefined) {
          const saved = saveVersion(team, { ...input.version, createdBy: input.createdBy });
          if ('kind' in saved) return Promise.resolve(saved);
        }
        teams.set(team.record.id, team);
        return Promise.resolve({ kind: 'created', team: view(team) });
      },
      get(id) {
        const team = live(id);
        return Promise.resolve(team === null ? null : view(team));
      },
      list(input = {}) {
        const ordered = [...teams.values()]
          .filter((team) => !team.deleted && team.record.workspaceId === workspaceId)
          .sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime());
        const cursor = input.cursor ?? null;
        const after =
          cursor === null
            ? ordered
            : ordered.filter((team) => team.record.createdAt.toISOString() < cursor.createdAt);
        const limit = input.limit ?? after.length;
        const page = after.slice(0, limit);
        const last = page.at(-1);
        return Promise.resolve({
          items: page.map(view),
          nextCursor:
            after.length > limit && last !== undefined
              ? { createdAt: last.record.createdAt.toISOString(), id: last.record.id }
              : null,
        });
      },
      softDelete(id) {
        const team = live(id);
        if (team !== null) team.deleted = true;
        return Promise.resolve(team !== null);
      },
      createVersion(teamId, input) {
        const team = live(teamId);
        if (team === null) return Promise.resolve({ kind: 'not-found' });
        const saved = saveVersion(team, input);
        return Promise.resolve('kind' in saved ? saved : { kind: 'created', version: saved });
      },
      getVersion(versionId) {
        const found = [...teams.values()]
          .filter((team) => team.record.workspaceId === workspaceId)
          .flatMap((team) => team.versions)
          .find((version) => version.id === versionId);
        return Promise.resolve(found ?? null);
      },
      listVersions(teamId, input = {}) {
        const team = live(teamId);
        if (team === null) return Promise.resolve(null);
        const cursor = input.cursor ?? null;
        const newest = [...team.versions]
          .reverse()
          .filter((version) => cursor === null || version.number < cursor);
        const limit = input.limit ?? newest.length;
        const page = newest.slice(0, limit);
        const last = page.at(-1);
        return Promise.resolve({
          items: page,
          nextCursor: newest.length > limit && last !== undefined ? last.number : null,
        });
      },
    };
  };

  return {
    audit,
    repository: (workspaceId) => Promise.resolve(repository(workspaceId)),
    recordAudit: (event) => {
      audit.push(event);
      return Promise.resolve();
    },
  };
}
