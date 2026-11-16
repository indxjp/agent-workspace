/**
 * The wire half of the agent-team routes (ADR-0104 acceptance, issue #1516, spec 04 §5.18): a
 * stored team or version rendered as its contract resource, and the list query (`limit`,
 * `cursor`) read strictly. Pure: no I/O.
 */
import {
  AGENT_TEAM_LIST_MAX_LIMIT,
  type AgentTeamResource,
  type AgentTeamVersion,
} from '@indx-workspace/contracts/agent-teams';

import { readListCursor } from '../pagination/list-cursor';
import type { AgentTeamListPosition, AgentTeamRecord, AgentTeamVersionRecord } from './runtime';

/** The page `GET /api/agent-teams` and the version list serve when the query names no `limit`. */
const AGENT_TEAM_LIST_DEFAULT_LIMIT = 50;

export function toAgentTeamVersion(record: AgentTeamVersionRecord): AgentTeamVersion {
  return {
    id: record.id,
    teamId: record.teamId,
    workspaceId: record.workspaceId,
    version: record.number,
    mode: record.mode,
    lead: { agentId: record.lead.agentId, agentVersionId: record.lead.agentVersionId },
    members: record.members.map(({ name, agentId, agentVersionId }) => ({
      name,
      agentId,
      agentVersionId,
    })),
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toAgentTeamResource(record: AgentTeamRecord): AgentTeamResource {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    latestVersion: record.latestVersion === null ? null : toAgentTeamVersion(record.latestVersion),
    ownerPrincipalId: record.ownerPrincipalId,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type QueryRead<Cursor> =
  | { readonly ok: true; readonly limit: number; readonly cursor: Cursor | null }
  | { readonly ok: false; readonly reason: string };

const ALLOWED_PARAMS = new Set(['limit', 'cursor']);

function readLimit(params: URLSearchParams): number | string {
  const raw = params.get('limit');
  if (raw === null) return AGENT_TEAM_LIST_DEFAULT_LIMIT;
  const limit = /^[1-9][0-9]{0,3}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit > AGENT_TEAM_LIST_MAX_LIMIT) {
    return `"limit" must be an integer from 1 to ${String(AGENT_TEAM_LIST_MAX_LIMIT)}.`;
  }
  return limit;
}

/** Only `limit` and `cursor`, each at most once; anything else is the caller's mistake. */
function unknownParameter(params: URLSearchParams): string | null {
  for (const key of new Set(params.keys())) {
    if (!ALLOWED_PARAMS.has(key)) return `${JSON.stringify(key)} is not a query parameter here.`;
    if (params.getAll(key).length > 1) return `"${key}" may be given once.`;
  }
  return null;
}

/** `GET /api/agent-teams`'s query: the cursor is bound to this list and this workspace. */
export function readTeamListQuery(
  params: URLSearchParams,
  workspaceId: string,
): QueryRead<AgentTeamListPosition> {
  const unknown = unknownParameter(params);
  if (unknown !== null) return { ok: false, reason: unknown };
  const limit = readLimit(params);
  if (typeof limit === 'string') return { ok: false, reason: limit };
  const cursor = readListCursor(params.get('cursor'), 'agent-teams', workspaceId);
  if (cursor.kind === 'invalid') return { ok: false, reason: cursor.reason };
  return { ok: true, limit, cursor: cursor.kind === 'ok' ? cursor.position : null };
}

const VERSION_CURSOR = /^v1\.([0-9a-f-]{36})\.([1-9][0-9]{0,9})$/u;

/**
 * The version list's cursor: the last version number served, bound to its team. `v1.<team>.<n>`
 * is opaque to a client and refused for any other team, so a cursor never moves across lists.
 */
export function encodeVersionCursor(teamId: string, number: number): string {
  return `v1.${teamId.toLowerCase()}.${String(number)}`;
}

/** `GET /api/agent-teams/:id/versions`' query. */
export function readVersionListQuery(params: URLSearchParams, teamId: string): QueryRead<number> {
  const unknown = unknownParameter(params);
  if (unknown !== null) return { ok: false, reason: unknown };
  const limit = readLimit(params);
  if (typeof limit === 'string') return { ok: false, reason: limit };
  const raw = params.get('cursor');
  if (raw === null) return { ok: true, limit, cursor: null };
  const match = VERSION_CURSOR.exec(raw);
  const number = match === null ? Number.NaN : Number(match[2]);
  if (match?.[1] !== teamId.toLowerCase() || !Number.isSafeInteger(number)) {
    return { ok: false, reason: 'the cursor is not one this list minted for this team.' };
  }
  return { ok: true, limit, cursor: number };
}
