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
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../client.js';
import { agentFiles } from '../schema/agent-files.js';
import { agentMcpServers } from '../schema/agent-mcp-servers.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agentPointerMoves, type AgentPointerMoveReason } from '../schema/agent-pointer-moves.js';
import {
  agentVersionEnvironments,
  agentVersionPointers,
  type AgentVersionEnvironment,
} from '../schema/agent-version-pointers.js';
import { agentVersions, agentVersionVias, type AgentVersionVia } from '../schema/agent-versions.js';
import { auditEvents } from '../schema/audit-events.js';
import {
  AgentPermissions as AgentPermissionsSchema,
  AgentStoredPolicy as AgentStoredPolicySchema,
  agents,
  parseAgentPermissions,
  parseAgentPolicy,
} from '../schema/agents.js';
import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { modelConnections } from '../schema/model-connections.js';
import { runtimeProfiles } from '../schema/runtime-profiles.js';
import { skills } from '../schema/skills.js';
import {
  narrowFileGrants,
  resolveFromRows,
  type AgentDefinitionReferenceKind,
  type DefinitionReferences,
  type NamedRow,
  type ResolveDefinitionOutcome,
  type ResolvedReferences,
} from './agent-versions-resolution.js';
import type { AgentPermissions, AgentRecord, AgentStoredPolicy } from './agents.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

export {
  agentDefinitionReferenceKinds,
  narrowFileGrants,
  resolveFromRows,
  type AgentDefinitionReferenceKind,
  type DefinitionReference,
  type DefinitionReferences,
  type FileGrant,
  type ResolveDefinitionOutcome,
  type ResolvedReferences,
} from './agent-versions-resolution.js';
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
}

export type CreateAgentVersionOutcome =
  | { readonly kind: 'created'; readonly version: AgentVersionRecord }
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
  | SubagentNestingOutcome
  | ReferenceGoneOutcome;

export interface CreateAgentWithFirstVersionInput {
  readonly agent: MaterialisedAgent & {
    readonly ownerPrincipalId: string;
    readonly createdBy: string | null;
  };
  readonly version: CreateAgentVersionInput;
  readonly environment: AgentVersionEnvironment;
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

/** Whether a stored version body (`unknown` here) declares at least one subagent. */
export function bodyDeclaresSubagents(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const subagents: unknown = Reflect.get(body, 'subagents');
  return Array.isArray(subagents) && subagents.length > 0;
}

/** Whether a stored version body (`unknown` here) carries a non-empty `description`. */
export function bodyHasDescription(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const description: unknown = Reflect.get(body, 'description');
  return typeof description === 'string' && description.length > 0;
}

/**
 * The runtime profile applying a version to `local` leaves on the agent row (issue #832): the
 * profile the version names, as resolved; for a version naming none (`aw push` always sends
 * `null`), the profile the agent already has, and the resolved workspace default only when it has
 * none. A push therefore never detaches a profile the console or setup attached.
 */
export function appliedRuntimeProfileId(
  body: unknown,
  current: string | null,
  resolved: string | null,
): string | null {
  const definition: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'definition') : null;
  const agent: unknown =
    typeof definition === 'object' && definition !== null ? Reflect.get(definition, 'agent') : null;
  const named =
    typeof agent === 'object' && agent !== null
      ? typeof Reflect.get(agent, 'runtimeProfileName') === 'string'
      : false;
  return named ? resolved : (current ?? resolved);
}

/** The subagent names a stored version body (`unknown` here) declares, in body order. */
export function bodySubagentNames(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null) return [];
  const subagents: unknown = Reflect.get(body, 'subagents');
  if (!Array.isArray(subagents)) return [];
  const names: string[] = [];
  for (const entry of subagents as readonly unknown[]) {
    const name: unknown =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : undefined;
    if (typeof name === 'string') names.push(name);
  }
  return names;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** Foreign keys whose violation means "a resolved reference is gone", by reference kind. */
const REFERENCE_CONSTRAINTS: ReadonlyMap<string, AgentDefinitionReferenceKind> = new Map([
  ['agent_skills_skill_workspace_fk', 'skill'],
  ['agent_mcp_servers_server_workspace_fk', 'connector'],
  ['agent_files_file_workspace_fk', 'file'],
  ['agents_model_connection_id_model_connections_id_fk', 'model-connection'],
  ['agents_model_connection_workspace_fk', 'model-connection'],
  ['agents_runtime_profile_id_runtime_profiles_id_fk', 'runtime-profile'],
  ['agents_runtime_profile_workspace_fk', 'runtime-profile'],
]);
const NAME_CONFLICT_CONSTRAINT = 'agents_workspace_name_key';
/** Foreign keys whose violation means "this principal is not one of this workspace's". */
const UNKNOWN_PRINCIPAL_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agent_versions_created_by_principal_workspace_fk',
  'agents_owner_principal_workspace_fk',
]);

type WriteFailure =
  | { readonly kind: 'name-conflict' }
  | { readonly kind: 'reference-gone'; readonly referenceKind: AgentDefinitionReferenceKind }
  | { readonly kind: 'unknown-principal' };

/** Classify a write failure by SQLSTATE and constraint name, or answer `null` (ADR-0015). */
function classifyWriteFailure(error: unknown): WriteFailure | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && failure.constraint === NAME_CONFLICT_CONSTRAINT) {
      return { kind: 'name-conflict' };
    }
    if (failure.code !== FOREIGN_KEY_VIOLATION) continue;
    const referenceKind = REFERENCE_CONSTRAINTS.get(failure.constraint);
    if (referenceKind !== undefined) return { kind: 'reference-gone', referenceKind };
    if (UNKNOWN_PRINCIPAL_CONSTRAINTS.has(failure.constraint)) return { kind: 'unknown-principal' };
  }
  return null;
}

/** The non-applied outcomes raised inside a transaction so that it rolls back. */
type RollbackOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'version-not-found' }
  | { readonly kind: 'surface-name-taken'; readonly name: string }
  | SubagentNestingOutcome;

/** Private: thrown inside a transaction to roll it back, and caught by the method that threw it. */
class Rollback extends Error {
  constructor(readonly outcome: RollbackOutcome) {
    super(`agent version transaction rolled back: ${outcome.kind}`);
    this.name = 'Rollback';
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

const AGENT_COLUMNS = {
  id: agents.id,
  workspaceId: agents.workspaceId,
  name: agents.name,
  instructions: agents.instructions,
  modelConnectionId: agents.modelConnectionId,
  model: agents.model,
  runtimeProfileId: agents.runtimeProfileId,
  permissions: agents.permissions,
  policy: agents.policy,
  createdBy: agents.createdBy,
  ownerPrincipalId: agents.ownerPrincipalId,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
} as const;

function toAgentRecord(row: {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  modelConnectionId: string | null;
  model: string | null;
  runtimeProfileId: string | null;
  permissions: unknown;
  policy: unknown;
  createdBy: string | null;
  ownerPrincipalId: string;
  createdAt: Date;
  updatedAt: Date;
}): AgentRecord {
  return {
    ...row,
    permissions: parseAgentPermissions(row.permissions),
    policy: parseAgentPolicy(row.policy),
  };
}

const VERSION_COLUMNS = {
  id: agentVersions.id,
  workspaceId: agentVersions.workspaceId,
  agentId: agentVersions.agentId,
  number: agentVersions.number,
  summary: agentVersions.summary,
  via: agentVersions.via,
  body: agentVersions.body,
  createdByPrincipalId: agentVersions.createdByPrincipalId,
  createdAt: agentVersions.createdAt,
} as const;

/** `body->'surfaces'` of a version alias, or an empty array when it is not an array. */
function surfacesOf(alias: string): SQL {
  const column = sql.raw(`${alias}.body`);
  return sql`case when jsonb_typeof(${column}->'surfaces') = 'array' then ${column}->'surfaces' else '[]'::jsonb end`;
}

const ConflictRow = z.object({ name: z.string() });
const PointedSurfaceRow = z.object({
  agent_id: z.string(),
  version_id: z.string(),
  number: z.number().int(),
  surface: z.unknown(),
});

/** The PostgreSQL {@link AgentVersionRepositoryProvider}. */
export function createDatabaseAgentVersionRepositoryProvider(
  db: Database,
): AgentVersionRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): AgentVersionRepository {
      const checked = requireWorkspaceScope(scope, 'AgentVersionRepositoryProvider');
      const workspaceId = checked.workspaceId;

      /** Serialise every pointer write in one workspace and environment (C9). */
      const lockPointers = async (
        tx: Transaction,
        environment: AgentVersionEnvironment,
      ): Promise<void> => {
        const key = `agent_version_pointers:${workspaceId}:${environment}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      };

      /** Replace the agent's three assignment tables, applying the #133 ceiling to files. */
      const writeAssignments = async (
        tx: Transaction,
        agentId: string,
        permissions: AgentPermissions,
        references: ResolvedReferences,
      ): Promise<void> => {
        await tx
          .delete(agentFiles)
          .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)));
        await tx
          .delete(agentSkills)
          .where(and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.agentId, agentId)));
        await tx
          .delete(agentMcpServers)
          .where(
            and(eq(agentMcpServers.workspaceId, workspaceId), eq(agentMcpServers.agentId, agentId)),
          );
        const grants = narrowFileGrants(references.files, permissions);
        const skillIds = [...new Set(references.skillIds)];
        const connectorIds = [...new Set(references.connectorIds)];
        if (grants.length > 0) {
          await tx
            .insert(agentFiles)
            .values(grants.map((grant) => ({ workspaceId, agentId, ...grant })));
        }
        if (skillIds.length > 0) {
          await tx
            .insert(agentSkills)
            .values(skillIds.map((skillId) => ({ workspaceId, agentId, skillId })));
        }
        if (connectorIds.length > 0) {
          await tx
            .insert(agentMcpServers)
            .values(connectorIds.map((mcpServerId) => ({ workspaceId, agentId, mcpServerId })));
        }
      };

      /**
       * Point `environment` of `agentId` at `version`, inserting or moving the pointer, and append
       * the move to its history. The only writer of either table; runs under {@link lockPointers}.
       */
      const movePointer = async (
        tx: Transaction,
        agentId: string,
        environment: AgentVersionEnvironment,
        version: { readonly id: string; readonly number: number },
        move: { readonly reason: AgentPointerMoveReason; readonly movedBy: string },
      ): Promise<AgentVersionPointerRecord> => {
        const rows = await tx
          .insert(agentVersionPointers)
          .values({ workspaceId, agentId, environment, versionId: version.id })
          .onConflictDoUpdate({
            target: [agentVersionPointers.agentId, agentVersionPointers.environment],
            set: { versionId: version.id, updatedAt: sql`now()` },
          })
          .returning({
            agentId: agentVersionPointers.agentId,
            environment: agentVersionPointers.environment,
            versionId: agentVersionPointers.versionId,
            updatedAt: agentVersionPointers.updatedAt,
          });
        const row = rows[0];
        if (row === undefined) throw new Error('the pointer upsert returned no row');
        await tx.insert(agentPointerMoves).values({
          workspaceId,
          agentId,
          environment,
          versionId: version.id,
          movedBy: move.movedBy,
          reason: move.reason,
        });
        return { ...row, number: version.number };
      };

      /**
       * C9: the first surface name of `versionId` that a version pointed by another agent in this
       * workspace and environment also serves, or `null`. Runs under {@link lockPointers}.
       */
      const takenSurfaceName = async (
        tx: Transaction,
        agentId: string,
        versionId: string,
        environment: AgentVersionEnvironment,
      ): Promise<string | null> => {
        const result = await tx.execute(sql`
          select mine.elem->>'name' as name
          from agent_versions v
          cross join lateral jsonb_array_elements(${surfacesOf('v')}) as mine(elem)
          join agent_version_pointers p
            on p.workspace_id = ${workspaceId}
           and p.environment = ${environment}
           and p.agent_id <> ${agentId}
          join agent_versions ov
            on ov.id = p.version_id
           and ov.workspace_id = ${workspaceId}
          cross join lateral jsonb_array_elements(${surfacesOf('ov')}) as theirs(elem)
          where v.workspace_id = ${workspaceId}
            and v.id = ${versionId}
            and mine.elem->>'name' is not null
            and theirs.elem->>'name' = mine.elem->>'name'
          order by 1
          limit 1`);
        const row = result.rows[0];
        return row === undefined ? null : ConflictRow.parse(row).name;
      };

      /** The agents named `names`, with whether their materialised version declares subagents and a description. */
      const candidatesByName = async (
        executor: Executor,
        names: readonly string[],
      ): Promise<ReadonlyMap<string, AgentSubagentCandidate>> => {
        if (names.length === 0) return new Map();
        const rows = await executor
          .select({ id: agents.id, name: agents.name, body: agentVersions.body })
          .from(agents)
          .leftJoin(
            agentVersions,
            and(
              eq(agentVersions.workspaceId, agents.workspaceId),
              eq(agentVersions.id, agents.materialisedVersionId),
            ),
          )
          .where(
            and(eq(agents.workspaceId, workspaceId), inArray(agents.name, [...new Set(names)])),
          );
        return new Map(
          rows.map((row) => [
            row.name,
            {
              id: row.id,
              hasSubagents: bodyDeclaresSubagents(row.body),
              hasDescription: bodyHasDescription(row.body),
            },
          ]),
        );
      };

      /** The other agents whose materialised version names `name` as a subagent, sorted. */
      const parentsOf = async (
        executor: Executor,
        name: string,
        excludeAgentId: string | null,
      ): Promise<readonly string[]> => {
        const result = await executor.execute(sql`
          select distinct a.name
          from agents a
          join agent_versions v
            on v.workspace_id = a.workspace_id
           and v.id = a.materialised_version_id
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(v.body->'subagents') = 'array' then v.body->'subagents' else '[]'::jsonb end
          ) as s(elem)
          where a.workspace_id = ${workspaceId}
            and (${excludeAgentId}::uuid is null or a.id <> ${excludeAgentId}::uuid)
            and s.elem->>'name' = ${name}`);
        return result.rows.map((row) => ConflictRow.parse(row).name).sort();
      };

      /**
       * One level of subagents, both ways, for the version `agentId` (`null`: not created yet) is
       * about to materialise under `name`. Takes the workspace's subagent lock first, so it must
       * run in the materialising transaction. A body without subagents creates no edge: no lock,
       * no check.
       */
      const checkSubagentNesting = async (
        tx: Transaction,
        agentId: string | null,
        name: string,
        body: unknown,
      ): Promise<void> => {
        const subagents = bodySubagentNames(body);
        if (subagents.length === 0) return;
        // ponytail: workspace-wide, taken only by bodies that declare subagents; per-name locks if those saves ever contend.
        const key = `agent_subagents:${workspaceId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        const candidates = await candidatesByName(tx, subagents);
        const unusable = subagents.filter((subagent) => {
          const candidate = candidates.get(subagent);
          return candidate === undefined || candidate.hasSubagents || candidate.id === agentId;
        });
        const parents = await parentsOf(tx, name, agentId);
        if (unusable.length > 0 || parents.length > 0) {
          throw new Rollback({ kind: 'subagent-nesting', unusable, parents });
        }
      };

      const readVersions = async (
        agentId: string,
        number?: number,
      ): Promise<readonly AgentVersionRecord[]> => {
        const predicate = and(
          eq(agentVersions.workspaceId, workspaceId),
          eq(agentVersions.agentId, agentId),
          number === undefined ? undefined : eq(agentVersions.number, number),
        );
        return db
          .select(VERSION_COLUMNS)
          .from(agentVersions)
          .where(predicate)
          .orderBy(asc(agentVersions.number));
      };

      /**
       * This workspace's rows of `kind` whose name (a file's path) — or, `by: 'id'`, whose id — is
       * one of `values`. An id that is not a UUID cannot match a `uuid` column and is never sent.
       */
      const referenceRows = async (
        kind: AgentDefinitionReferenceKind,
        by: 'id' | 'name',
        values: readonly string[],
      ): Promise<readonly NamedRow[]> => {
        const wanted = [...new Set(values)].filter(
          (value) => by === 'name' || UUID_PATTERN.test(value),
        );
        if (wanted.length === 0) return [];
        switch (kind) {
          case 'skill':
            return db
              .select({ id: skills.id, name: skills.name })
              .from(skills)
              .where(
                and(
                  eq(skills.workspaceId, workspaceId),
                  inArray(by === 'id' ? skills.id : skills.name, wanted),
                ),
              );
          case 'connector':
            return db
              .select({ id: mcpServers.id, name: mcpServers.name })
              .from(mcpServers)
              .where(
                and(
                  // Every kind: a tool connector is referenced by its name (ADR-0113 C15) and
                  // compose hands it to the engine through the gateway (S2-02f, #531).
                  eq(mcpServers.workspaceId, workspaceId),
                  inArray(by === 'id' ? mcpServers.id : mcpServers.name, wanted),
                ),
              );
          case 'file':
            return db
              .select({ id: files.id, name: files.path })
              .from(files)
              .where(
                and(
                  eq(files.workspaceId, workspaceId),
                  inArray(by === 'id' ? files.id : files.path, wanted),
                ),
              );
          case 'model-connection':
            return db
              .select({ id: modelConnections.id, name: modelConnections.name })
              .from(modelConnections)
              .where(
                and(
                  eq(modelConnections.workspaceId, workspaceId),
                  inArray(by === 'id' ? modelConnections.id : modelConnections.name, wanted),
                ),
              );
          case 'runtime-profile':
            return db
              .select({ id: runtimeProfiles.id, name: runtimeProfiles.name })
              .from(runtimeProfiles)
              .where(
                and(
                  eq(runtimeProfiles.workspaceId, workspaceId),
                  inArray(by === 'id' ? runtimeProfiles.id : runtimeProfiles.name, wanted),
                ),
              );
        }
      };
      /** This workspace's default runtime profile id (issue #504), or `null` when it has none. */
      const workspaceDefaultRuntimeProfileId = async (): Promise<string | null> => {
        const rows = await db
          .select({ id: runtimeProfiles.id })
          .from(runtimeProfiles)
          .where(
            and(
              eq(runtimeProfiles.workspaceId, workspaceId),
              eq(runtimeProfiles.workspaceDefault, true),
            ),
          )
          .limit(1);
        return rows[0]?.id ?? null;
      };

      /** Map a failed write to an outcome, or re-throw what this module cannot name. */
      const referenceGoneOrNameConflict = (
        error: unknown,
        name: string,
      ): { readonly kind: 'name-conflict'; readonly name: string } | ReferenceGoneOutcome => {
        const failure = classifyWriteFailure(error);
        if (failure?.kind === 'name-conflict') return { kind: 'name-conflict', name };
        if (failure?.kind === 'reference-gone') {
          return { kind: 'reference-gone', referenceKind: failure.referenceKind };
        }
        throw error;
      };

      return {
        async create(agentId, input): Promise<CreateAgentVersionOutcome> {
          try {
            return await db.transaction(async (tx) => {
              const locked = await tx
                .select({ id: agents.id })
                .from(agents)
                .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
                .for('update');
              if (locked[0] === undefined) return { kind: 'not-found' };
              const next = await tx
                .select({
                  number: sql`coalesce(max(${agentVersions.number}), 0) + 1`.mapWith(Number),
                })
                .from(agentVersions)
                .where(
                  and(
                    eq(agentVersions.workspaceId, workspaceId),
                    eq(agentVersions.agentId, agentId),
                  ),
                );
              const rows = await tx
                .insert(agentVersions)
                .values({
                  workspaceId,
                  agentId,
                  number: next[0]?.number ?? 1,
                  summary: input.summary,
                  via: input.via,
                  body: input.body,
                  createdByPrincipalId: input.createdByPrincipalId,
                })
                .returning(VERSION_COLUMNS);
              const version = rows[0];
              if (version === undefined) throw new Error('the version insert returned no row');
              return { kind: 'created', version };
            });
          } catch (error) {
            if (classifyWriteFailure(error)?.kind === 'unknown-principal') {
              return { kind: 'unknown-principal' };
            }
            throw error;
          }
        },

        async list(agentId): Promise<AgentVersionListing | null> {
          const agent = await db
            .select({ materialisedVersionId: agents.materialisedVersionId })
            .from(agents)
            .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
            .limit(1);
          if (agent[0] === undefined) return null;
          const [versions, pointers] = await Promise.all([
            readVersions(agentId),
            db
              .select({
                agentId: agentVersionPointers.agentId,
                environment: agentVersionPointers.environment,
                versionId: agentVersionPointers.versionId,
                number: agentVersions.number,
                updatedAt: agentVersionPointers.updatedAt,
              })
              .from(agentVersionPointers)
              .innerJoin(
                agentVersions,
                and(
                  eq(agentVersions.id, agentVersionPointers.versionId),
                  eq(agentVersions.workspaceId, workspaceId),
                ),
              )
              .where(
                and(
                  eq(agentVersionPointers.workspaceId, workspaceId),
                  eq(agentVersionPointers.agentId, agentId),
                ),
              )
              .orderBy(asc(agentVersionPointers.environment)),
          ]);
          return { versions, pointers, materialisedVersionId: agent[0].materialisedVersionId };
        },

        async find(agentId, number): Promise<AgentVersionRecord | null> {
          const rows = await readVersions(agentId, number);
          return rows[0] ?? null;
        },

        async findById(versionId): Promise<AgentVersionRecord | null> {
          const rows = await db
            .select(VERSION_COLUMNS)
            .from(agentVersions)
            .where(and(eq(agentVersions.workspaceId, workspaceId), eq(agentVersions.id, versionId)))
            .limit(1);
          return rows[0] ?? null;
        },

        async resolveDefinition(references): Promise<ResolveDefinitionOutcome> {
          const modelConnectionName = references.modelConnectionName ?? 'default';
          const [
            skillRows,
            connectorRows,
            fileRows,
            connectionRows,
            profileRows,
            defaultProfileId,
          ] = await Promise.all([
            referenceRows('skill', 'name', references.skills),
            referenceRows('connector', 'name', references.connectors),
            referenceRows(
              'file',
              'name',
              references.files.map((grant) => grant.path),
            ),
            referenceRows('model-connection', 'name', [modelConnectionName]),
            referenceRows(
              'runtime-profile',
              'name',
              references.runtimeProfileName === null ? [] : [references.runtimeProfileName],
            ),
            references.runtimeProfileName === null
              ? workspaceDefaultRuntimeProfileId()
              : Promise.resolve(null),
          ]);
          return resolveFromRows(
            references,
            {
              skill: skillRows,
              connector: connectorRows,
              file: fileRows,
              'model-connection': connectionRows,
              'runtime-profile': profileRows,
            },
            defaultProfileId,
          );
        },

        async namesOf(ids): Promise<ReferenceNames> {
          const byId = async (kind: AgentDefinitionReferenceKind) =>
            new Map(
              (await referenceRows(kind, 'id', ids[kind] ?? [])).map((row) => [row.id, row.name]),
            );
          const [skill, connector, file, modelConnection, runtimeProfile] = await Promise.all([
            byId('skill'),
            byId('connector'),
            byId('file'),
            byId('model-connection'),
            byId('runtime-profile'),
          ]);
          return {
            skill,
            connector,
            file,
            'model-connection': modelConnection,
            'runtime-profile': runtimeProfile,
          };
        },

        async stdioConnectorNames(names): Promise<readonly string[]> {
          if (names.length === 0) return [];
          const rows = await db
            .select({ name: mcpServers.name })
            .from(mcpServers)
            .where(
              and(
                eq(mcpServers.workspaceId, workspaceId),
                eq(mcpServers.kind, 'mcp'),
                eq(mcpServers.transport, 'stdio'),
                inArray(mcpServers.name, [...new Set(names)]),
              ),
            )
            .orderBy(asc(mcpServers.name));
          return rows.map((row) => row.name);
        },

        async mcpConnectorIdsByName(names): Promise<ReadonlyMap<string, string>> {
          if (names.length === 0) return new Map();
          const rows = await db
            .select({ id: mcpServers.id, name: mcpServers.name })
            .from(mcpServers)
            .where(
              and(
                eq(mcpServers.workspaceId, workspaceId),
                eq(mcpServers.kind, 'mcp'),
                inArray(mcpServers.name, [...new Set(names)]),
              ),
            );
          // `mcp_servers_workspace_name_key`: a name is one connector's.
          return new Map(rows.map((row) => [row.name, row.id]));
        },

        agentsByName(names): Promise<ReadonlyMap<string, AgentSubagentCandidate>> {
          return candidatesByName(db, names);
        },

        subagentParents(name, excludeAgentId): Promise<readonly string[]> {
          return parentsOf(db, name, excludeAgentId);
        },

        async applyAndPoint(agentId, input): Promise<ApplyAndPointOutcome> {
          const { agent: materialised, environment } = input;
          const permissions = AgentPermissionsSchema.parse(materialised.permissions);
          const policy =
            materialised.policy === null
              ? null
              : AgentStoredPolicySchema.parse(materialised.policy);
          try {
            return await db.transaction(async (tx) => {
              await lockPointers(tx, environment);
              const locked = await tx
                .select({ id: agents.id, runtimeProfileId: agents.runtimeProfileId })
                .from(agents)
                .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
                .for('update');
              const current = locked[0];
              if (current === undefined) throw new Rollback({ kind: 'not-found' });
              const versions = await tx
                .select({
                  id: agentVersions.id,
                  number: agentVersions.number,
                  body: agentVersions.body,
                })
                .from(agentVersions)
                .where(
                  and(
                    eq(agentVersions.workspaceId, workspaceId),
                    eq(agentVersions.agentId, agentId),
                    eq(agentVersions.number, input.number),
                  ),
                );
              const version = versions[0];
              if (version === undefined) throw new Rollback({ kind: 'version-not-found' });
              if (environment === 'local') {
                await checkSubagentNesting(tx, agentId, materialised.name, version.body);
              }

              // The agent row is `local`'s working copy (issue #612): another environment's move
              // rewrites only its pointer, and answers the row as it is.
              const updated =
                environment === 'local'
                  ? await tx
                      .update(agents)
                      .set({
                        name: materialised.name,
                        instructions: materialised.instructions,
                        model: materialised.model,
                        modelConnectionId: materialised.references.modelConnectionId,
                        runtimeProfileId: appliedRuntimeProfileId(
                          version.body,
                          current.runtimeProfileId,
                          materialised.references.runtimeProfileId,
                        ),
                        permissions: { ...permissions },
                        policy,
                        materialisedVersionId: version.id,
                      })
                      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
                      .returning(AGENT_COLUMNS)
                  : await tx
                      .select(AGENT_COLUMNS)
                      .from(agents)
                      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));
              const row = updated[0];
              if (row === undefined) throw new Error('the locked agent row was not read back');

              if (environment === 'local') {
                await writeAssignments(tx, agentId, permissions, materialised.references);
              }
              const pointer = await movePointer(tx, agentId, environment, version, {
                reason: input.reason,
                movedBy: input.audit.actorPrincipalId,
              });
              const taken = await takenSurfaceName(tx, agentId, version.id, environment);
              if (taken !== null) throw new Rollback({ kind: 'surface-name-taken', name: taken });
              await tx.insert(auditEvents).values({
                workspaceId,
                action: 'agent-changed',
                subjectId: agentId,
                subjectLabel: input.audit.subjectLabel,
                actorPrincipalId: input.audit.actorPrincipalId,
                actorUserId: input.audit.actorUserId,
                actorLabel: input.audit.actorLabel,
              });
              return { kind: 'applied', agent: toAgentRecord(row), pointer };
            });
          } catch (error) {
            if (error instanceof Rollback) return error.outcome;
            return referenceGoneOrNameConflict(error, materialised.name);
          }
        },

        async createAgentWithFirstVersion(input): Promise<CreateAgentWithFirstVersionOutcome> {
          const { agent: materialised, environment, version: versionInput } = input;
          const permissions = AgentPermissionsSchema.parse(materialised.permissions);
          const policy =
            materialised.policy === null
              ? null
              : AgentStoredPolicySchema.parse(materialised.policy);
          try {
            return await db.transaction(async (tx) => {
              await lockPointers(tx, environment);
              await checkSubagentNesting(tx, null, materialised.name, versionInput.body);
              const inserted = await tx
                .insert(agents)
                .values({
                  workspaceId,
                  name: materialised.name,
                  instructions: materialised.instructions,
                  model: materialised.model,
                  modelConnectionId: materialised.references.modelConnectionId,
                  runtimeProfileId: materialised.references.runtimeProfileId,
                  permissions: { ...permissions },
                  policy,
                  ownerPrincipalId: materialised.ownerPrincipalId,
                  createdBy: materialised.createdBy,
                })
                .returning(AGENT_COLUMNS);
              const agentRow = inserted[0];
              if (agentRow === undefined) throw new Error('the agent insert returned no row');

              await writeAssignments(tx, agentRow.id, permissions, materialised.references);
              const versions = await tx
                .insert(agentVersions)
                .values({
                  workspaceId,
                  agentId: agentRow.id,
                  number: 1,
                  summary: versionInput.summary,
                  via: versionInput.via,
                  body: versionInput.body,
                  createdByPrincipalId: versionInput.createdByPrincipalId,
                })
                .returning(VERSION_COLUMNS);
              const version = versions[0];
              if (version === undefined) throw new Error('the version insert returned no row');
              // The version needs the agent's id, so the row learns its version second.
              const materialisedRows = await tx
                .update(agents)
                .set({ materialisedVersionId: version.id })
                .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentRow.id)))
                .returning(AGENT_COLUMNS);
              const materialisedRow = materialisedRows[0];
              if (materialisedRow === undefined)
                throw new Error('the new agent row was not updated');
              const pointer = await movePointer(tx, agentRow.id, environment, version, {
                reason: 'set',
                movedBy: versionInput.createdByPrincipalId,
              });
              const taken = await takenSurfaceName(tx, agentRow.id, version.id, environment);
              if (taken !== null) throw new Rollback({ kind: 'surface-name-taken', name: taken });
              return { kind: 'created', agent: toAgentRecord(materialisedRow), version, pointer };
            });
          } catch (error) {
            if (error instanceof Rollback) {
              if (
                error.outcome.kind === 'surface-name-taken' ||
                error.outcome.kind === 'subagent-nesting'
              ) {
                return error.outcome;
              }
              throw error;
            }
            if (classifyWriteFailure(error)?.kind === 'unknown-principal') {
              return { kind: 'unknown-principal' };
            }
            return referenceGoneOrNameConflict(error, materialised.name);
          }
        },

        async listMoves(agentId, environment, limit): Promise<readonly AgentPointerMoveRecord[]> {
          return db
            .select({
              environment: agentPointerMoves.environment,
              number: agentVersions.number,
              reason: agentPointerMoves.reason,
              movedByPrincipalId: agentPointerMoves.movedBy,
              movedAt: agentPointerMoves.movedAt,
            })
            .from(agentPointerMoves)
            .innerJoin(
              agentVersions,
              and(
                eq(agentVersions.id, agentPointerMoves.versionId),
                eq(agentVersions.workspaceId, workspaceId),
              ),
            )
            .where(
              and(
                eq(agentPointerMoves.workspaceId, workspaceId),
                eq(agentPointerMoves.agentId, agentId),
                environment === null ? undefined : eq(agentPointerMoves.environment, environment),
              ),
            )
            .orderBy(desc(agentPointerMoves.movedAt))
            .limit(limit);
        },

        async findPointedSurface(environment, name): Promise<PointedSurface | null> {
          const result = await db.execute(sql`
            select p.agent_id, p.version_id, v.number, s.elem as surface
            from agent_version_pointers p
            join agent_versions v
              on v.id = p.version_id
             and v.workspace_id = ${workspaceId}
            cross join lateral jsonb_array_elements(${surfacesOf('v')}) as s(elem)
            where p.workspace_id = ${workspaceId}
              and p.environment = ${environment}
              and s.elem->>'name' = ${name}
            order by p.updated_at, p.agent_id
            limit 1`);
          const row = result.rows[0];
          if (row === undefined) return null;
          const parsed = PointedSurfaceRow.parse(row);
          return {
            agentId: parsed.agent_id,
            versionId: parsed.version_id,
            number: parsed.number,
            surface: parsed.surface,
          };
        },

        async listPointedSurfaceNames(): Promise<readonly string[]> {
          const result = await db.execute(sql`
            select distinct s.elem->>'name' as name
            from agent_version_pointers p
            join agent_versions v
              on v.id = p.version_id
             and v.workspace_id = ${workspaceId}
            cross join lateral jsonb_array_elements(${surfacesOf('v')}) as s(elem)
            where p.workspace_id = ${workspaceId}
              and jsonb_typeof(s.elem->'name') = 'string'
            order by name`);
          return z
            .array(z.object({ name: z.string() }))
            .parse(result.rows)
            .map((row) => row.name);
        },
      };
    },
  };
}
