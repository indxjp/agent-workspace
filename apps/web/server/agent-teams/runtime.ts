/**
 * The seam between the agent-team routes (ADR-0104 acceptance, issue #1516, spec 04 §5.18) and the
 * database layer: one workspace's team repository and the audit trail its writes go to. The same
 * shape as `webhooks/runtime.ts`, for the same reason: only `store.ts` names
 * `@agent-workspace/core/db` (F-15). The core repository satisfies every type here structurally.
 */
import type { AgentTeamMode } from '@indx-workspace/contracts/agent-teams';

import type { RunPrincipal } from '../execution';

/** One pinned agent version. */
interface AgentTeamPinRecord {
  readonly agentId: string;
  readonly agentVersionId: string;
}

/** One saved, immutable team version; `members` are ordered by name. */
export interface AgentTeamVersionRecord {
  readonly id: string;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly number: number;
  readonly mode: AgentTeamMode;
  readonly lead: AgentTeamPinRecord;
  readonly members: readonly (AgentTeamPinRecord & { readonly name: string })[];
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

/** A live team with its newest version (`null` before its first). */
export interface AgentTeamRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerPrincipalId: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly latestVersion: AgentTeamVersionRecord | null;
}

/** A version to save; a member without a name takes its agent's name when that is valid. */
export interface AgentTeamVersionInput {
  readonly lead: AgentTeamPinRecord;
  readonly members: readonly (AgentTeamPinRecord & { readonly name?: string })[];
  readonly createdBy: string | null;
}

/** Why a version's members were refused: each is `422 agent_team_member_invalid`. */
export interface AgentTeamMemberInvalid {
  readonly kind: 'member-invalid';
  readonly problem:
    | 'member-count'
    | 'lead-is-member'
    | 'duplicate-agent'
    | 'unknown-version'
    | 'member-name-invalid'
    | 'member-name-repeated';
  readonly agentId?: string;
}

/** A keyset boundary as the core repository mints it: `created_at` text and the row id. */
export interface AgentTeamListPosition {
  readonly createdAt: string;
  readonly id: string;
}

/** The teams of one workspace. Semantics are documented on the core repository. */
export interface AgentTeamRepository {
  create(input: {
    readonly name: string;
    readonly description?: string | null;
    readonly ownerPrincipalId: string;
    readonly createdBy: string | null;
    readonly version?: Omit<AgentTeamVersionInput, 'createdBy'>;
  }): Promise<
    | { readonly kind: 'created'; readonly team: AgentTeamRecord }
    | { readonly kind: 'name-taken' }
    | { readonly kind: 'unknown-principal' }
    | AgentTeamMemberInvalid
  >;
  get(id: string): Promise<AgentTeamRecord | null>;
  list(input?: {
    readonly limit?: number;
    readonly cursor?: AgentTeamListPosition | null;
  }): Promise<{
    readonly items: readonly AgentTeamRecord[];
    readonly nextCursor: AgentTeamListPosition | null;
  }>;
  softDelete(id: string): Promise<boolean>;
  createVersion(
    teamId: string,
    input: AgentTeamVersionInput,
  ): Promise<
    | { readonly kind: 'created'; readonly version: AgentTeamVersionRecord }
    | { readonly kind: 'not-found' }
    | AgentTeamMemberInvalid
  >;
  /** One version by id, even of a deleted team (a team run pins it); `null` when there is none. */
  getVersion(versionId: string): Promise<AgentTeamVersionRecord | null>;
  listVersions(
    teamId: string,
    input?: { readonly limit?: number; readonly cursor?: number | null },
  ): Promise<{
    readonly items: readonly AgentTeamVersionRecord[];
    readonly nextCursor: number | null;
  } | null>;
}

/**
 * One audit row for a team write. A team write is the same write as on an agent (ADR-0104
 * acceptance decision 10), so it is recorded as `agent-changed` with the team as its subject.
 * shortcut: no `agent-team-*` audit action, until the audit vocabulary gains one by migration.
 */
export interface AgentTeamAuditEvent {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: 'agent-changed';
  readonly subjectId: string;
  readonly subjectLabel: string;
}

/** The lead run a verified run token names, and the person it acts for. */
export interface LeadRunCaller {
  readonly runId: string;
  readonly workspaceId: string;
  /** When the lead run's token, and so the lead run, ends, in epoch milliseconds. */
  readonly expiresAtMs: number;
  /**
   * The person the lead run acts for (ADR-0142 D2 `caller`), as a principal of the workspace, or
   * `null` when no person is behind the run: every member call is then `team_member_forbidden`.
   */
  readonly person: RunPrincipal | null;
}

/** Turns the `Authorization` header into the lead run it is a live run token of, or `null`. */
export type MemberCallerVerifier = (authorization: string | null) => Promise<LeadRunCaller | null>;

/** The agent-team routes' runtime, as `ApplicationContext.agentTeams` holds it. */
export interface AgentTeamsRuntime {
  /**
   * The member endpoint's run-token verifier (ADR-0104 acceptance decision 4). Absent where no
   * `GATEWAY_TOKEN_SECRET` is configured, and then every member call answers `401`.
   */
  readonly verifyMemberCaller?: MemberCallerVerifier;
  /** The teams of `workspaceId`; another workspace's team is as absent as one never created. */
  repository(workspaceId: string): Promise<AgentTeamRepository>;
  recordAudit(event: AgentTeamAuditEvent): Promise<void>;
}
