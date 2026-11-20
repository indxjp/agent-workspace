/** The agent-team repository's record, input and outcome types, and its public interfaces. */
import type { AgentTeamMode } from '@indx-workspace/contracts/agent-teams';

import type { Database } from '../client.js';
import type { KeysetPage, KeysetPosition } from './keyset.js';
import type { WorkspaceScope } from './scope.js';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** What the read helpers need: the database or a transaction. */
export type Reader = Pick<Transaction, 'select' | 'selectDistinctOn'>;

/** One pinned agent version. */
export interface AgentTeamPinRecord {
  readonly agentId: string;
  readonly agentVersionId: string;
}

export interface AgentTeamMemberRecord extends AgentTeamPinRecord {
  readonly name: string;
}

export interface AgentTeamVersionRecord {
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

export interface AgentTeamRecord {
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
export interface NewAgentTeamVersionInput {
  readonly lead: AgentTeamPinRecord;
  readonly members: readonly (AgentTeamPinRecord & { readonly name?: string })[];
  /** The user saving it, or `null` for an API-key principal. */
  readonly createdBy: string | null;
}

export interface NewAgentTeamInput {
  /** Already trimmed and bounded by the contract. */
  readonly name: string;
  readonly description?: string | null;
  readonly ownerPrincipalId: string;
  readonly createdBy: string | null;
  /** Saved as version 1 in the same transaction, when given. */
  readonly version?: Omit<NewAgentTeamVersionInput, 'createdBy'>;
}

/** Why a version's members were refused: each is `422 agent_team_member_invalid`. */
export type AgentTeamMemberProblem =
  | 'member-count'
  | 'lead-is-member'
  | 'duplicate-agent'
  | 'unknown-version'
  | 'member-name-invalid'
  | 'member-name-repeated';

export interface AgentTeamMemberInvalid {
  readonly kind: 'member-invalid';
  readonly problem: AgentTeamMemberProblem;
  /** The agent the problem is about, when it is about one. */
  readonly agentId?: string;
}

export type CreateAgentTeamOutcome =
  | { readonly kind: 'created'; readonly team: AgentTeamRecord }
  | { readonly kind: 'name-taken' }
  | { readonly kind: 'unknown-principal' }
  | AgentTeamMemberInvalid;

export type CreateAgentTeamVersionOutcome =
  | { readonly kind: 'created'; readonly version: AgentTeamVersionRecord }
  | { readonly kind: 'not-found' }
  | AgentTeamMemberInvalid;

export interface AgentTeamListInput {
  /** 1–AGENT_TEAM_LIST_MAX_LIMIT; omitted, every remaining team in one page. */
  readonly limit?: number;
  readonly cursor?: KeysetPosition | null;
}

export interface AgentTeamVersionListInput {
  /** 1–AGENT_TEAM_LIST_MAX_LIMIT; omitted, every remaining version in one page. */
  readonly limit?: number;
  /** The `nextCursor` of the previous page: versions numbered below it come next. */
  readonly cursor?: number | null;
}

/** Versions newest (highest number) first; `nextCursor` is the last number served. */
export interface AgentTeamVersionPage {
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
