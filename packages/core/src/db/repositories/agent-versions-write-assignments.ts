/** The agent assignment tables and version storage grants the version writes replace. */
import { and, asc, eq, inArray } from 'drizzle-orm';

import { agentFiles } from '../schema/agent-files.js';
import { agentMcpServers } from '../schema/agent-mcp-servers.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agentStorageGrants } from '../schema/agent-storage-grants.js';
import { agentVersionStorageGrants } from '../schema/agent-version-storage-grants.js';
import { auditEvents } from '../schema/audit-events.js';
import { skills } from '../schema/skills.js';
import { storageConnections } from '../schema/storage-connections.js';
import type { AgentPointerAudit } from './agent-versions.js';
import {
  narrowFileGrants,
  narrowStorageGrants,
  storageGrantChange,
  type ResolvedReferences,
  type StorageGrantRef,
} from './agent-versions-resolution.js';
import type { Transaction } from './agent-versions-shared.js';
import { Rollback } from './agent-versions-write-failures.js';
import type { AgentPermissions } from './agents.js';

/** What an agent is assigned: its references narrowed by its permissions, and who to audit. */
interface AgentAssignments {
  readonly permissions: AgentPermissions;
  readonly references: ResolvedReferences;
  /** Absent writes no `storage-grant-changed` row. */
  readonly audit: AgentPointerAudit | undefined;
}

export interface AssignmentWrites {
  readonly writeAssignments: (
    tx: Transaction,
    agentId: string,
    assignments: AgentAssignments,
  ) => Promise<void>;
  readonly writeVersionStorageGrants: (
    tx: Transaction,
    versionId: string,
    grants: readonly StorageGrantRef[],
  ) => Promise<void>;
}

/** The agent whose assignment rows are written. */
interface AssignmentOwner {
  readonly workspaceId: string;
  readonly agentId: string;
}

/** The actor columns of an audit row written for `audit`. */
export function actorOf(audit: AgentPointerAudit): {
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
} {
  return {
    actorPrincipalId: audit.actorPrincipalId,
    actorUserId: audit.actorUserId,
    actorLabel: audit.actorLabel,
  };
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * The grants whose connection is still one of this workspace's, share-locking those connections
 * so none is deleted before the transaction ends. A connection deleted since validation is
 * exactly one deleted just after the deploy: its grant is dropped, and a run of the version fails
 * closed (`run_storage_grant_unavailable`), instead of the write failing on the foreign key.
 */
async function liveStorageGrants(
  tx: Transaction,
  workspaceId: string,
  grants: readonly StorageGrantRef[],
): Promise<readonly StorageGrantRef[]> {
  if (grants.length === 0) return [];
  const present = await tx
    .select({ id: storageConnections.id })
    .from(storageConnections)
    .where(
      and(
        eq(storageConnections.workspaceId, workspaceId),
        inArray(storageConnections.id, unique(grants.map((grant) => grant.connectionId))),
      ),
    )
    .orderBy(asc(storageConnections.id))
    .for('key share');
  const alive = new Set(present.map((row) => row.id));
  return grants.filter((grant) => alive.has(grant.connectionId));
}

// A skill whose delete is under way is gone to a writer, like one deleted a moment ago: the
// caller re-resolves and the name no longer resolves. Share-locked, so a delete marking the
// row either lands first (and is seen here) or waits for this write and finds the skill in use.
async function lockWantedSkills(
  tx: Transaction,
  workspaceId: string,
  skillIds: readonly string[],
): Promise<void> {
  const wanted = unique(skillIds);
  if (wanted.length === 0) return;
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

async function deleteFileSkillAndConnectorRows(
  tx: Transaction,
  { workspaceId, agentId }: AssignmentOwner,
): Promise<void> {
  await tx
    .delete(agentFiles)
    .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)));
  await tx
    .delete(agentSkills)
    .where(and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.agentId, agentId)));
  await tx
    .delete(agentMcpServers)
    .where(and(eq(agentMcpServers.workspaceId, workspaceId), eq(agentMcpServers.agentId, agentId)));
}

/** Replace the storage grants, auditing a change when `assignments.audit` is present. */
async function replaceStorageGrants(
  tx: Transaction,
  owner: AssignmentOwner,
  { permissions, references, audit }: AgentAssignments,
): Promise<void> {
  const { workspaceId, agentId } = owner;
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
  const storage = await liveStorageGrants(
    tx,
    workspaceId,
    narrowStorageGrants(references.storageGrants ?? [], permissions),
  );
  if (storage.length > 0) {
    await tx.insert(agentStorageGrants).values(storage.map((grant) => ({ ...owner, ...grant })));
  }
  const change = storageGrantChange(previousStorage, storage);
  if (audit !== undefined && change !== null) {
    await tx.insert(auditEvents).values({
      workspaceId,
      action: 'storage-grant-changed',
      subjectId: agentId,
      subjectLabel: `${audit.subjectLabel}: ${change}`,
      ...actorOf(audit),
    });
  }
}

async function insertFileSkillAndConnectorRows(
  tx: Transaction,
  owner: AssignmentOwner,
  { permissions, references }: AgentAssignments,
): Promise<void> {
  const grants = narrowFileGrants(references.files, permissions);
  const skillIds = unique(references.skillIds);
  const connectorIds = unique(references.connectorIds);
  if (grants.length > 0) {
    await tx.insert(agentFiles).values(grants.map((grant) => ({ ...owner, ...grant })));
  }
  if (skillIds.length > 0) {
    await tx.insert(agentSkills).values(
      skillIds.map((skillId) => ({
        ...owner,
        skillId,
        revision: references.skillRevisions?.[skillId] ?? null,
      })),
    );
  }
  if (connectorIds.length > 0) {
    await tx
      .insert(agentMcpServers)
      .values(connectorIds.map((mcpServerId) => ({ ...owner, mcpServerId })));
  }
}

export function assignmentWrites(workspaceId: string): AssignmentWrites {
  return {
    /**
     * Replace the agent's four assignment tables, applying the #133 ceiling to files and storage
     * grants. When the storage grants differ from the ones they replace, one `storage-grant-changed`
     * row (connection id, prefix and access of each grant, no credential) is audited in the same
     * transaction; `audit` absent writes none.
     */
    async writeAssignments(tx, agentId, assignments) {
      const owner = { workspaceId, agentId };
      await lockWantedSkills(tx, workspaceId, assignments.references.skillIds);
      await deleteFileSkillAndConnectorRows(tx, owner);
      await replaceStorageGrants(tx, owner, assignments);
      await insertFileSkillAndConnectorRows(tx, owner, assignments);
    },

    /**
     * Record the folders `version` was deployed with, keeping only {@link liveStorageGrants}. Rows
     * are never rewritten.
     */
    async writeVersionStorageGrants(tx, versionId, grants) {
      const rows = await liveStorageGrants(tx, workspaceId, grants);
      if (rows.length > 0) {
        await tx
          .insert(agentVersionStorageGrants)
          .values(rows.map((grant) => ({ workspaceId, versionId, ...grant })))
          .onConflictDoNothing();
      }
    },
  };
}
