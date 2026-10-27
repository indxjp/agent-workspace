/**
 * The agent version store — issue #442 (S1-04), ADR-0101 (the platform owns agent versions) and
 * ADR-0108 (surfaces travel inside a version).
 *
 * `agent_versions` is an immutable, numbered history of one agent's definition;
 * `agent_version_pointers` says which version each environment runs. This repository is the only
 * writer of both. There is no update and no delete of a version: a version is history, and the
 * agent's cascade is the only thing that removes one.
 *
 * ## Shape
 *
 * The same shape as `./agents.ts`: obtained for a {@link WorkspaceScope}, no method takes a
 * workspace id, every predicate is built here from the scope, and every expected failure is a
 * named member of a discriminated union. Violations are classified positively — SQLSTATE *and*
 * constraint name — and anything unrecognised is re-thrown (ADR-0015).
 *
 * ## The body is `unknown` here
 *
 * Core does not parse a version body, so it is stored as `jsonb` and handed back as `unknown`. The server (S1-05, S1-06) parses it with the contracts'
 * `AgentVersionBodySchema` before it reads it (R-15 §4). The SQL below reads exactly one path of it,
 * `body->'surfaces'` and `body->'subagents'` (the nesting rule below), and treats anything that is
 * not an array there as "none"; `appliedRuntimeProfileId` reads
 * `definition.agent.runtimeProfileName` the same defensive way.
 *
 * ## Contracts this file implements
 *
 * * **C7** — a definition's `modelConnectionName` of `null` or `'default'` resolves to the
 *   connection named `default` when the workspace has one, and otherwise to `null` (the deployment
 *   default). It is never reported missing. See `resolveFromRows`.
 * * **Runtime profile default** (issue #504, S1-22; ADR-0101 amendment) — a definition's
 *   `runtimeProfileName` of `null` resolves to the workspace's default runtime profile
 *   (the one whose `runtime_profiles.workspace_default` is `true`) at the moment the version is applied, and to `null`
 *   when the workspace has chosen none. It is never reported missing or ambiguous; a named profile
 *   resolves exactly as before, and the default plays no part in it. Applying such a version to
 *   `local` keeps the profile the agent row already has and writes the default only to a row
 *   with none (issue #832, `appliedRuntimeProfileId`).
 * * **C9** — within one workspace and environment, a surface name is served by at most one pointed
 *   version. Checked in SQL inside the pointing transaction, under an advisory lock keyed on the
 *   workspace and environment, so two agents pointed at the same moment cannot both pass the check.
 *
 * * **One level of subagents** (ADR-0133 D14) — an agent whose materialised version declares
 *   subagents may not be named as a subagent, and an agent that is named as one may not declare
 *   any. Checked in both directions inside the transactions that materialise a version, under an
 *   advisory lock keyed on the workspace, so two concurrent materialisations (A names B while B
 *   names C) cannot together build A→B→C.
 *
 * ## Applying a version is one transaction
 *
 * {@link AgentVersionRepository.applyAndPoint} rewrites the agent row and its three assignment
 * tables (`local` only: the row is that environment's working copy), moves the pointer, checks C9,
 * appends the move to `agent_pointer_moves` (issue #615), and writes the move's `agent-changed` audit
 * row (ADR-0101), all in one transaction. A non-applied
 * outcome is raised inside the transaction as a private {@link Rollback}, so nothing it wrote
 * survives, and is mapped back to an outcome outside it; it writes no audit row.
 * A failing audit insert is not an outcome this module names, so it is re-thrown (ADR-0015) and the
 * whole move — agent row, assignments, pointer and history row — rolls back with it.
 *
 * ## One writer of pointers
 *
 * `movePointer` is the only code that writes `agent_version_pointers`, and it always appends the
 * move to `agent_pointer_moves` beside it, so the newest history row of an environment is its
 * pointer (issue #615). Promote and rollback are `applyAndPoint` calls with their own `reason`.
 *
 * ## Where the code lives
 *
 * This file holds the public records, the repository interface and the provider. The methods are
 * split by kind: `./agent-versions-read.ts`, `./agent-versions-query.ts` (reference resolution and
 * subagent lookups) and `./agent-versions-write.ts` (`movePointer`, `Rollback` and the
 * transactions); `./agent-versions-shared.ts` holds what more than one of them uses.
 */
import type { AgentCreatedByAgent, BuiltinAgentKey } from '@indx-workspace/contracts/agents';
import type { AgentCreatedAuditDetails } from '@indx-workspace/contracts/observability';

import type { Database } from '../client.js';
import type { AgentPointerMoveReason } from '../schema/agent-pointer-moves.js';
import {
  agentVersionEnvironments,
  type AgentVersionEnvironment,
} from '../schema/agent-version-pointers.js';
import { agentVersionVias, type AgentVersionVia } from '../schema/agent-versions.js';
import { agentVersionQueries } from './agent-versions-query.js';
import { agentVersionReads } from './agent-versions-read.js';
import type {
  AgentDefinitionReferenceKind,
  DefinitionReferences,
  ResolveDefinitionOutcome,
  ResolvedReferences,
  StorageGrantRef,
} from './agent-versions-resolution.js';
import { agentVersionWrites } from './agent-versions-write.js';
import type { AgentPermissions, AgentRecord, AgentStoredPolicy } from './agents.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export {
  agentDefinitionReferenceKinds,
  narrowFileGrants,
  narrowStorageGrants,
  storageGrantChange,
  resolveFromRows,
  type AgentDefinitionReferenceKind,
  type DefinitionReference,
  type DefinitionReferences,
  type FileGrant,
  type ResolveDefinitionOutcome,
  type ResolvedReferences,
  type StorageGrantRef,
} from './agent-versions-resolution.js';
export {
  appliedRuntimeProfileId,
  bodyDeclaresSubagents,
  bodyHasDescription,
  bodySubagentNames,
} from './agent-versions-shared.js';
export {
  agentVersionEnvironments,
  agentVersionVias,
  type AgentPointerMoveReason,
  type AgentVersionEnvironment,
  type AgentVersionVia,
};

/**
 * One version row. `body` is the definition exactly as written; the server parses it with the
 * contracts' `AgentVersionBodySchema` (R-15 §4); core does not parse it.
 */
export interface AgentVersionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly number: number;
  readonly summary: string;
  readonly via: AgentVersionVia;
  readonly body: unknown;
  readonly createdByPrincipalId: string;
  readonly createdAt: Date;
}

/** Which version one environment of one agent runs. */
export interface AgentVersionPointerRecord {
  readonly agentId: string;
  readonly environment: AgentVersionEnvironment;
  readonly versionId: string;
  readonly number: number;
  readonly updatedAt: Date;
}

/** One row of an environment's pointer history (issue #615). */
export interface AgentPointerMoveRecord {
  readonly environment: AgentVersionEnvironment;
  readonly number: number;
  readonly reason: AgentPointerMoveReason;
  /** `null` only for a move the migration backfilled from a pointer that predates the history. */
  readonly movedByPrincipalId: string | null;
  readonly movedAt: Date;
}

/** What writing a version supplies. The agent, workspace and number come from elsewhere. */
export interface CreateAgentVersionInput {
  readonly summary: string;
  readonly via: AgentVersionVia;
  readonly body: unknown;
  /** Resolved from the authenticated actor, never from a request body. */
  readonly createdByPrincipalId: string;
  /**
   * The storage folders the validated pipeline resolved for this version, by connection id; stored
   * with the version row. Absent means none. A connection that is gone by insert time is skipped,
   * so the version then fails closed at run time instead of the write failing.
   */
  readonly storageGrants?: readonly StorageGrantRef[] | undefined;
  /**
   * The number the version must take; when the agent's next number is another, nothing is saved
   * and the outcome is `number-taken`. Checked under the agent's row lock, so of two concurrent
   * saves expecting one number exactly one is created. Absent: the next number, whatever it is.
   */
  readonly number?: number;
}

export type CreateAgentVersionOutcome =
  | { readonly kind: 'created'; readonly version: AgentVersionRecord }
  | { readonly kind: 'number-taken' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unknown-principal' };

/** An agent's whole history and where each environment points. */
export interface AgentVersionListing {
  /** Number ascending. */
  readonly versions: readonly AgentVersionRecord[];
  readonly pointers: readonly AgentVersionPointerRecord[];
  /**
   * The version the agent row was last written from, or `null` once a write outside the version
   * pipeline has edited it (`agents.materialised_version_id`).
   */
  readonly materialisedVersionId: string | null;
}

/** An agent as a version materialises it: the row's settable columns and its assignments. */
export interface MaterialisedAgent {
  readonly name: string;
  readonly instructions: string;
  readonly model: string | null;
  readonly permissions: AgentPermissions;
  readonly policy: AgentStoredPolicy | null;
  readonly references: ResolvedReferences;
}

/**
 * The `agent-changed` row a pointer move writes inside its transaction (ADR-0101). The workspace,
 * the action and the subject id are fixed by the repository from its scope and the call, so a
 * caller cannot audit a different subject or workspace.
 */
export interface AgentPointerAudit {
  readonly subjectLabel: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
}

export interface ApplyAndPointInput {
  readonly environment: AgentVersionEnvironment;
  readonly number: number;
  readonly agent: MaterialisedAgent;
  /** Recorded in the move's history row; `audit.actorPrincipalId` is its `moved_by`. */
  readonly reason: AgentPointerMoveReason;
  /** Required: no caller can move a pointer without leaving a record of it. */
  readonly audit: AgentPointerAudit;
  /**
   * Compare-and-set: the version number `environment` must point at when the move runs, or `null`
   * for "must be unset". A different pointer answers `pointer-moved` and moves nothing. Absent
   * means unconditional. Checked under the same lock that serialises the move, so two moves that
   * expect one version cannot both apply.
   *
   * A refused move leaves any version the caller created for it saved and unpointed. That is safe
   * by design (builder design §08 Data rule 2): an unpointed version runs nothing.
   */
  readonly expectedVersion?: number | null;
}

/** A reference that resolved a moment ago and is gone now (or never belonged here). */
export interface ReferenceGoneOutcome {
  readonly kind: 'reference-gone';
  readonly referenceKind: AgentDefinitionReferenceKind;
}

/**
 * The version being materialised would nest subagents: `unusable` are the subagents it names that
 * are missing or declare subagents themselves (body order); `parents` are the other agents that
 * already name this agent as a subagent (sorted), which it may not gain subagents under.
 */
export interface SubagentNestingOutcome {
  readonly kind: 'subagent-nesting';
  readonly unusable: readonly string[];
  readonly parents: readonly string[];
}

/** `expectedVersion` did not match: `current` is the number the environment points at, or `null`. */
export interface PointerMovedOutcome {
  readonly kind: 'pointer-moved';
  readonly current: number | null;
}

export type ApplyAndPointOutcome =
  | {
      readonly kind: 'applied';
      readonly agent: AgentRecord;
      readonly pointer: AgentVersionPointerRecord;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'version-not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'surface-name-taken'; readonly name: string }
  | PointerMovedOutcome
  | SubagentNestingOutcome
  | ReferenceGoneOutcome;

/**
 * The `agent-created` row a create writes inside its transaction. The workspace, action, subject
 * (the new agent and its name) and the details' `agentId`, `version` and `via` are fixed by the repository.
 */
interface AgentCreatedAuditInput {
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly details: Omit<AgentCreatedAuditDetails, 'agentId' | 'version' | 'via'>;
}

export interface CreateAgentWithFirstVersionInput {
  readonly agent: MaterialisedAgent & {
    readonly ownerPrincipalId: string;
    readonly createdBy: string | null;
    /** Marks the row as this built-in agent in the same insert; absent for an ordinary agent. */
    readonly builtin?: BuiltinAgentKey;
    /** Lineage of an agent made by an agent, written in the same insert (issue #1851). */
    readonly createdByAgent?: AgentCreatedByAgent & { readonly agentId: string };
  };
  readonly version: CreateAgentVersionInput;
  readonly environment: AgentVersionEnvironment;
  /** Who a `storage-grant-changed` row is attributed to; without it no grant audit is written. */
  readonly audit?: AgentPointerAudit | undefined;
  /** Written as an `agent-created` row in the same transaction; a refused row rolls the create back. */
  readonly agentCreatedAudit?: AgentCreatedAuditInput | undefined;
  /**
   * Refuses the create when the workspace already has `limit` agents created since `since`,
   * counted under the transaction's pointer lock so two concurrent creates cannot both pass.
   */
  readonly quota?: { readonly since: Date; readonly limit: number } | undefined;
}

export type CreateAgentWithFirstVersionOutcome =
  | {
      readonly kind: 'created';
      readonly agent: AgentRecord;
      readonly version: AgentVersionRecord;
      readonly pointer: AgentVersionPointerRecord;
    }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'surface-name-taken'; readonly name: string }
  | SubagentNestingOutcome
  /** The agent's owner or the version's author is not a principal of this workspace. */
  | { readonly kind: 'unknown-principal' }
  /** `createdByAgent` names no agent of this workspace. */
  | { readonly kind: 'unknown-creator-agent' }
  /** The workspace has already created `quota.limit` agents since `quota.since`. */
  | { readonly kind: 'quota-exceeded' }
  | ReferenceGoneOutcome;

/** The surface a pointed version serves under a name (C9 makes it at most one). */
export interface PointedSurface {
  readonly agentId: string;
  readonly versionId: string;
  readonly number: number;
  /** One element of the version body's `surfaces`, unparsed; the server parses it. */
  readonly surface: unknown;
}

/** Ids to name, per reference kind; an absent kind asks for none. */
export type ReferenceIds = Partial<Record<AgentDefinitionReferenceKind, readonly string[]>>;

/** `id → name` (a file's name is its path) for each id this workspace has; any other id is absent. */
export type ReferenceNames = Readonly<
  Record<AgentDefinitionReferenceKind, ReadonlyMap<string, string>>
>;

/** What the subagent check needs to know about a named agent. */
export interface AgentSubagentCandidate {
  readonly id: string;
  /** The agent's materialised version declares subagents of its own. */
  readonly hasSubagents: boolean;
  /** The agent's materialised version body has a `description` (a parent's model needs it). */
  readonly hasDescription: boolean;
}

/** Version persistence for exactly one workspace. No method takes a workspace id. */
export interface AgentVersionRepository {
  create(agentId: string, input: CreateAgentVersionInput): Promise<CreateAgentVersionOutcome>;
  /** `null` when this workspace has no agent with that id. */
  list(agentId: string): Promise<AgentVersionListing | null>;
  find(agentId: string, number: number): Promise<AgentVersionRecord | null>;
  /** The version with this id, or `null` when this workspace has none (a session's pin, #612). */
  findById(versionId: string): Promise<AgentVersionRecord | null>;
  resolveDefinition(references: DefinitionReferences): Promise<ResolveDefinitionOutcome>;
  /**
   * The inverse of {@link resolveDefinition}'s lookup: the names of the ids this workspace has, so
   * a console edit made by id can be saved as a name-keyed version (issue #616).
   */
  namesOf(ids: ReferenceIds): Promise<ReferenceNames>;
  /**
   * Which of the connector `names` are MCP connectors of this workspace that launch a process
   * (`transport: stdio`), sorted. A version lists connectors by name; only a stdio one needs a
   * tool sandbox to run (issue #793).
   */
  stdioConnectorNames(names: readonly string[]): Promise<readonly string[]>;
  /**
   * The id of each of this workspace's MCP connectors (`kind: mcp`, not a tool connector) named one
   * of `names`, by name; a name no MCP connector has is absent. A saved tool rule written against a
   * connector's name is stored against its id (ADR-0113 SD13, #1109).
   */
  mcpConnectorIdsByName(names: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * The agents of this workspace named `names`, by name: absent for a name no agent has.
   * `hasSubagents` reads the agent's materialised version body (`body.subagents` is a non-empty
   * array); an agent with no materialised version has none (ADR-0133 D14).
   */
  agentsByName(names: readonly string[]): Promise<ReadonlyMap<string, AgentSubagentCandidate>>;
  /**
   * Whether any agent of this workspace holds a storage grant on the connection. A connection
   * delete must refuse while it does; the database refuses it too (`NO ACTION` foreign key).
   */
  isConnectionGranted(connectionId: string): Promise<boolean>;
  /**
   * The storage folders version `versionId` was deployed with (its own rows, never the agent's
   * current grants), ordered by connection id then prefix. Empty when it has none or this workspace
   * has no such version.
   */
  storageGrantsOf(versionId: string): Promise<readonly StorageGrantRef[]>;
  /**
   * The names of the other agents of this workspace whose materialised version names `name` as a
   * subagent, sorted. `excludeAgentId` is the agent being saved (`null` for one not yet created).
   */
  subagentParents(name: string, excludeAgentId: string | null): Promise<readonly string[]>;
  /**
   * Point `environment` at a version and write the move's `agent-changed` audit row, in one
   * transaction. A `local` move also rewrites the agent row and its assignments from the version;
   * any other environment's leaves them as they are. A refused outcome writes nothing; a failing
   * audit insert rejects and rolls the whole move back.
   */
  applyAndPoint(agentId: string, input: ApplyAndPointInput): Promise<ApplyAndPointOutcome>;
  createAgentWithFirstVersion(
    input: CreateAgentWithFirstVersionInput,
  ): Promise<CreateAgentWithFirstVersionOutcome>;
  /** How many agents this workspace created at or after `since`, whoever made them. */
  agentsCreatedSince(since: Date): Promise<number>;
  /**
   * The last `limit` moves of `agentId`'s pointers, newest first: of one environment, or of every
   * environment when it is `null`. Empty for an agent this workspace does not have.
   */
  listMoves(
    agentId: string,
    environment: AgentVersionEnvironment | null,
    limit: number,
  ): Promise<readonly AgentPointerMoveRecord[]>;
  findPointedSurface(
    environment: AgentVersionEnvironment,
    name: string,
  ): Promise<PointedSurface | null>;
  /** The distinct names of the surfaces a pointed version of this workspace carries, sorted. */
  listPointedSurfaceNames(): Promise<readonly string[]>;
}

export interface AgentVersionRepositoryProvider {
  forScope(scope: WorkspaceScope): AgentVersionRepository;
}

/** The PostgreSQL {@link AgentVersionRepositoryProvider}. */
export function createDatabaseAgentVersionRepositoryProvider(
  db: Database,
): AgentVersionRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): AgentVersionRepository {
      const checked = requireWorkspaceScope(scope, 'AgentVersionRepositoryProvider');
      const workspaceId = checked.workspaceId;
      return {
        ...agentVersionReads(db, workspaceId),
        ...agentVersionQueries(db, workspaceId),
        ...agentVersionWrites(db, workspaceId),
      };
    },
  };
}
