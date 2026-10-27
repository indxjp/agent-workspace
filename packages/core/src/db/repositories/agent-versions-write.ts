/** The write half of the agent version store; see `./agent-versions.ts`. */
import { and, asc, count, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentFiles } from '../schema/agent-files.js';
import { agentMcpServers } from '../schema/agent-mcp-servers.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agentStorageGrants } from '../schema/agent-storage-grants.js';
import { agentVersionStorageGrants } from '../schema/agent-version-storage-grants.js';
import { storageConnections } from '../schema/storage-connections.js';
import { agentPointerMoves, type AgentPointerMoveReason } from '../schema/agent-pointer-moves.js';
import {
  agentVersionPointers,
  type AgentVersionEnvironment,
} from '../schema/agent-version-pointers.js';
import { skills } from '../schema/skills.js';
import { agentVersions } from '../schema/agent-versions.js';
import { auditEvents } from '../schema/audit-events.js';
import {
  AgentPermissions as AgentPermissionsSchema,
  AgentStoredPolicy as AgentStoredPolicySchema,
  agents,
  parseAgentPermissions,
  parseAgentPolicy,
  parseBuiltinKey,
} from '../schema/agents.js';
import type {
  AgentPointerAudit,
  AgentVersionPointerRecord,
  AgentVersionRepository,
  ApplyAndPointOutcome,
  CreateAgentVersionOutcome,
  CreateAgentWithFirstVersionOutcome,
  PointerMovedOutcome,
  ReferenceGoneOutcome,
  SubagentNestingOutcome,
} from './agent-versions.js';
import { subagentLookups } from './agent-versions-query.js';
import {
  narrowFileGrants,
  narrowStorageGrants,
  storageGrantChange,
  type AgentDefinitionReferenceKind,
  type ResolvedReferences,
  type StorageGrantRef,
} from './agent-versions-resolution.js';
import {
  appliedRuntimeProfileId,
  bodySubagentNames,
  ConflictRow,
  surfacesOf,
  VERSION_COLUMNS,
  type Transaction,
} from './agent-versions-shared.js';
import type { AgentPermissions, AgentRecord } from './agents.js';
import { checkedAuditEvent } from './audit-events.js';
import { postgresViolations } from './violations.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** Foreign keys whose violation means "a resolved reference is gone", by reference kind. */
const REFERENCE_CONSTRAINTS: ReadonlyMap<string, AgentDefinitionReferenceKind> = new Map([
  ['agent_skills_skill_workspace_fk', 'skill'],
  ['agent_skills_skill_revision_fk', 'skill'],
  ['agent_mcp_servers_server_workspace_fk', 'connector'],
  ['agent_files_file_workspace_fk', 'file'],
  ['agents_model_connection_id_model_connections_id_fk', 'model-connection'],
  ['agents_model_connection_workspace_fk', 'model-connection'],
  ['agents_runtime_profile_id_runtime_profiles_id_fk', 'runtime-profile'],
  ['agents_runtime_profile_workspace_fk', 'runtime-profile'],
]);
/** A second built-in of one kind (`agents_workspace_builtin_key`) is the same refusal as a taken name. */
const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agents_workspace_name_key',
  'agents_workspace_builtin_key',
]);
/** Foreign keys whose violation means "this principal is not one of this workspace's". */
const UNKNOWN_PRINCIPAL_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agent_versions_created_by_principal_workspace_fk',
  'agents_owner_principal_workspace_fk',
]);
/** The lineage foreign keys: the creating agent does not exist, or is not one of this workspace's. */
const UNKNOWN_CREATOR_AGENT_CONSTRAINTS = new Set([
  'agents_created_by_agent_id_agents_id_fk',
  'agents_created_by_agent_workspace_fk',
]);
/** A half-set lineage is refused the same way: the creator cannot be recorded. */
const LINEAGE_CHECK = 'agents_created_by_agent_lineage_check';

type WriteFailure =
  | { readonly kind: 'name-conflict' }
  | { readonly kind: 'reference-gone'; readonly referenceKind: AgentDefinitionReferenceKind }
  | { readonly kind: 'unknown-principal' }
  | { readonly kind: 'unknown-creator-agent' };

/** Classify a write failure by SQLSTATE and constraint name, or answer `null` (ADR-0015). */
function classifyWriteFailure(error: unknown): WriteFailure | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return { kind: 'name-conflict' };
    }
    if (failure.code === CHECK_VIOLATION && failure.constraint === LINEAGE_CHECK) {
      return { kind: 'unknown-creator-agent' };
    }
    if (failure.code !== FOREIGN_KEY_VIOLATION) continue;
    const referenceKind = REFERENCE_CONSTRAINTS.get(failure.constraint);
    if (referenceKind !== undefined) return { kind: 'reference-gone', referenceKind };
    if (UNKNOWN_PRINCIPAL_CONSTRAINTS.has(failure.constraint)) return { kind: 'unknown-principal' };
    if (UNKNOWN_CREATOR_AGENT_CONSTRAINTS.has(failure.constraint)) {
      return { kind: 'unknown-creator-agent' };
    }
  }
  return null;
}

/** The non-applied outcomes raised inside a transaction so that it rolls back. */
type RollbackOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'version-not-found' }
  | { readonly kind: 'surface-name-taken'; readonly name: string }
  | { readonly kind: 'reference-gone'; readonly referenceKind: AgentDefinitionReferenceKind }
  | PointerMovedOutcome
  | SubagentNestingOutcome;

/** Private: thrown inside a transaction to roll it back, and caught by the method that threw it. */
class Rollback extends Error {
  constructor(readonly outcome: RollbackOutcome) {
    super(`agent version transaction rolled back: ${outcome.kind}`);
    this.name = 'Rollback';
  }
}

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
  builtinKey: agents.builtinKey,
  createdByAgentId: agents.createdByAgentId,
  createdByAgentVersion: agents.createdByAgentVersion,
  createdByRunId: agents.createdByRunId,
  archivedAt: agents.archivedAt,
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
  builtinKey: string | null;
  createdByAgentId: string | null;
  createdByAgentVersion: number | null;
  createdByRunId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentRecord {
  const {
    builtinKey,
    createdByAgentId,
    createdByAgentVersion,
    createdByRunId,
    archivedAt,
    ...columns
  } = row;
  const builtin = parseBuiltinKey(builtinKey);
  return {
    ...columns,
    permissions: parseAgentPermissions(row.permissions),
    policy: parseAgentPolicy(row.policy),
    ...(builtin === undefined ? {} : { builtin }),
    // The lineage CHECK makes the version and the run both present or both absent.
    ...(createdByAgentVersion === null || createdByRunId === null
      ? {}
      : {
          createdByAgent: {
            agentId: createdByAgentId,
            version: createdByAgentVersion,
            runId: createdByRunId,
          },
        }),
    ...(archivedAt === null ? {} : { archivedAt }),
  };
}

export function agentVersionWrites(
  db: Database,
  workspaceId: string,
): Pick<
  AgentVersionRepository,
  'create' | 'applyAndPoint' | 'createAgentWithFirstVersion' | 'agentsCreatedSince'
> {
  const { candidatesByName, parentsOf } = subagentLookups(workspaceId);

  /** Serialise every pointer write in one workspace and environment (C9). */
  const lockPointers = async (
    tx: Transaction,
    environment: AgentVersionEnvironment,
  ): Promise<void> => {
    const key = `agent_version_pointers:${workspaceId}:${environment}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  };

  /**
   * The agents this workspace created since `since`, whoever made them: the one count behind the
   * quota rule and the in-transaction re-check, so they cannot disagree. It counts `agents` rows,
   * as a console create writes no `agent-created` audit row.
   */
  const countCreatedSince = async (
    executor: Pick<Transaction, 'select'>,
    since: Date,
  ): Promise<number> => {
    const rows = await executor
      .select({ value: count() })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          // The platform's own built-in rows are provisioned, not created by anyone's save.
          isNull(agents.builtinKey),
          gte(agents.createdAt, since),
        ),
      );
    return rows[0]?.value ?? 0;
  };

  /**
   * Replace the agent's four assignment tables, applying the #133 ceiling to files and storage
   * grants. When the storage grants differ from the ones they replace, one `storage-grant-changed`
   * row (connection id, prefix and access of each grant, no credential) is audited in the same
   * transaction; `audit` absent writes none.
   */
  const writeAssignments = async (
    tx: Transaction,
    agentId: string,
    permissions: AgentPermissions,
    references: ResolvedReferences,
    audit: AgentPointerAudit | undefined,
  ): Promise<void> => {
    // A skill whose delete is under way is gone to a writer, like one deleted a moment ago: the
    // caller re-resolves and the name no longer resolves. Share-locked, so a delete marking the
    // row either lands first (and is seen here) or waits for this write and finds the skill in use.
    const wanted = [...new Set(references.skillIds)];
    if (wanted.length > 0) {
      const locked = await tx
        .select({ pendingDelete: skills.pendingDelete })
        .from(skills)
        .where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, wanted)))
        .orderBy(asc(skills.id))
        .for('share');
      if (locked.some((row) => row.pendingDelete !== null)) {
        throw new Rollback({ kind: 'reference-gone', referenceKind: 'skill' });
      }
    }
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
    const ownGrants = and(
      eq(agentStorageGrants.workspaceId, workspaceId),
      eq(agentStorageGrants.agentId, agentId),
    );
    const previousStorage = await tx
      .select({
        connectionId: agentStorageGrants.connectionId,
        prefix: agentStorageGrants.prefix,
        access: agentStorageGrants.access,
      })
      .from(agentStorageGrants)
      .where(ownGrants);
    await tx.delete(agentStorageGrants).where(ownGrants);
    const storage = narrowStorageGrants(references.storageGrants ?? [], permissions);
    if (storage.length > 0) {
      await tx
        .insert(agentStorageGrants)
        .values(storage.map((grant) => ({ workspaceId, agentId, ...grant })));
    }
    const change = storageGrantChange(previousStorage, storage);
    if (audit !== undefined && change !== null) {
      await tx.insert(auditEvents).values({
        workspaceId,
        action: 'storage-grant-changed',
        subjectId: agentId,
        subjectLabel: `${audit.subjectLabel}: ${change}`,
        actorPrincipalId: audit.actorPrincipalId,
        actorUserId: audit.actorUserId,
        actorLabel: audit.actorLabel,
      });
    }
    const grants = narrowFileGrants(references.files, permissions);
    const skillIds = [...new Set(references.skillIds)];
    const connectorIds = [...new Set(references.connectorIds)];
    if (grants.length > 0) {
      await tx
        .insert(agentFiles)
        .values(grants.map((grant) => ({ workspaceId, agentId, ...grant })));
    }
    if (skillIds.length > 0) {
      await tx.insert(agentSkills).values(
        skillIds.map((skillId) => ({
          workspaceId,
          agentId,
          skillId,
          revision: references.skillRevisions?.[skillId] ?? null,
        })),
      );
    }
    if (connectorIds.length > 0) {
      await tx
        .insert(agentMcpServers)
        .values(connectorIds.map((mcpServerId) => ({ workspaceId, agentId, mcpServerId })));
    }
  };

  /**
   * Record the folders `version` was deployed with. Share-locks the connections first and keeps
   * the rows of those still present: a connection deleted since validation is exactly one deleted
   * just after the deploy, so the version fails closed at run time rather than the write failing
   * on the foreign key. Rows are never rewritten.
   */
  const writeVersionStorageGrants = async (
    tx: Transaction,
    versionId: string,
    grants: readonly StorageGrantRef[],
  ): Promise<void> => {
    if (grants.length === 0) return;
    const present = await tx
      .select({ id: storageConnections.id })
      .from(storageConnections)
      .where(
        and(
          eq(storageConnections.workspaceId, workspaceId),
          inArray(storageConnections.id, [...new Set(grants.map((grant) => grant.connectionId))]),
        ),
      )
      .orderBy(asc(storageConnections.id))
      .for('key share');
    const alive = new Set(present.map((row) => row.id));
    const rows = grants.filter((grant) => alive.has(grant.connectionId));
    if (rows.length > 0) {
      await tx
        .insert(agentVersionStorageGrants)
        .values(rows.map((grant) => ({ workspaceId, versionId, ...grant })))
        .onConflictDoNothing();
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

  /** The version number `environment` of `agentId` points at, or `null` when it points at none. */
  const pointedNumber = async (
    tx: Transaction,
    agentId: string,
    environment: AgentVersionEnvironment,
  ): Promise<number | null> => {
    const rows = await tx
      .select({ number: agentVersions.number })
      .from(agentVersionPointers)
      .innerJoin(agentVersions, eq(agentVersions.id, agentVersionPointers.versionId))
      .where(
        and(
          eq(agentVersionPointers.workspaceId, workspaceId),
          eq(agentVersionPointers.agentId, agentId),
          eq(agentVersionPointers.environment, environment),
        ),
      );
    return rows[0]?.number ?? null;
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
    agentsCreatedSince: (since) => countCreatedSince(db, since),

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
              and(eq(agentVersions.workspaceId, workspaceId), eq(agentVersions.agentId, agentId)),
            );
          const number = next[0]?.number ?? 1;
          if (input.number !== undefined && input.number !== number)
            return { kind: 'number-taken' };
          const rows = await tx
            .insert(agentVersions)
            .values({
              workspaceId,
              agentId,
              number,
              summary: input.summary,
              via: input.via,
              body: input.body,
              createdByPrincipalId: input.createdByPrincipalId,
            })
            .returning(VERSION_COLUMNS);
          const version = rows[0];
          if (version === undefined) throw new Error('the version insert returned no row');
          await writeVersionStorageGrants(tx, version.id, input.storageGrants ?? []);
          return { kind: 'created', version };
        });
      } catch (error) {
        if (classifyWriteFailure(error)?.kind === 'unknown-principal') {
          return { kind: 'unknown-principal' };
        }
        throw error;
      }
    },

    async applyAndPoint(agentId, input): Promise<ApplyAndPointOutcome> {
      const { agent: materialised, environment } = input;
      const permissions = AgentPermissionsSchema.parse(materialised.permissions);
      const policy =
        materialised.policy === null ? null : AgentStoredPolicySchema.parse(materialised.policy);
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
          if (input.expectedVersion !== undefined) {
            const pointed = await pointedNumber(tx, agentId, environment);
            if (pointed !== input.expectedVersion) {
              throw new Rollback({ kind: 'pointer-moved', current: pointed });
            }
          }
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
            await writeAssignments(tx, agentId, permissions, materialised.references, input.audit);
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
        materialised.policy === null ? null : AgentStoredPolicySchema.parse(materialised.policy);
      try {
        return await db.transaction(async (tx) => {
          // The key is `workspace:environment`, and every create uses FIRST_ENVIRONMENT ('local'), so
          // this serialises every creation in the workspace: the quota count below cannot race.
          await lockPointers(tx, environment);
          if (
            input.quota !== undefined &&
            (await countCreatedSince(tx, input.quota.since)) >= input.quota.limit
          ) {
            // Nothing has been written, so returning commits only the lock release.
            return { kind: 'quota-exceeded' };
          }
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
              builtinKey: materialised.builtin ?? null,
              createdByAgentId: materialised.createdByAgent?.agentId ?? null,
              createdByAgentVersion: materialised.createdByAgent?.version ?? null,
              createdByRunId: materialised.createdByAgent?.runId ?? null,
            })
            .returning(AGENT_COLUMNS);
          const agentRow = inserted[0];
          if (agentRow === undefined) throw new Error('the agent insert returned no row');

          await writeAssignments(
            tx,
            agentRow.id,
            permissions,
            materialised.references,
            input.audit,
          );
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
          await writeVersionStorageGrants(
            tx,
            version.id,
            narrowStorageGrants(materialised.references.storageGrants ?? [], permissions),
          );
          // The version needs the agent's id, so the row learns its version second.
          const materialisedRows = await tx
            .update(agents)
            .set({ materialisedVersionId: version.id })
            .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentRow.id)))
            .returning(AGENT_COLUMNS);
          const materialisedRow = materialisedRows[0];
          if (materialisedRow === undefined) throw new Error('the new agent row was not updated');
          const pointer = await movePointer(tx, agentRow.id, environment, version, {
            reason: 'set',
            movedBy: versionInput.createdByPrincipalId,
          });
          const taken = await takenSurfaceName(tx, agentRow.id, version.id, environment);
          if (taken !== null) throw new Rollback({ kind: 'surface-name-taken', name: taken });
          if (input.agentCreatedAudit !== undefined) {
            const { details, ...actor } = input.agentCreatedAudit;
            await tx.insert(auditEvents).values(
              checkedAuditEvent({
                ...actor,
                workspaceId,
                action: 'agent-created',
                subjectId: agentRow.id,
                subjectLabel: materialised.name,
                details: {
                  ...details,
                  agentId: agentRow.id,
                  version: version.number,
                  via: versionInput.via,
                },
              }),
            );
          }
          return { kind: 'created', agent: toAgentRecord(materialisedRow), version, pointer };
        });
      } catch (error) {
        if (error instanceof Rollback) {
          if (
            error.outcome.kind === 'surface-name-taken' ||
            error.outcome.kind === 'subagent-nesting' ||
            error.outcome.kind === 'reference-gone'
          ) {
            return error.outcome;
          }
          throw error;
        }
        const failure = classifyWriteFailure(error);
        if (failure?.kind === 'unknown-principal' || failure?.kind === 'unknown-creator-agent') {
          return { kind: failure.kind };
        }
        return referenceGoneOrNameConflict(error, materialised.name);
      }
    },
  };
}
