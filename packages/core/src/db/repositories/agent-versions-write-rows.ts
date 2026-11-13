/** The agent and version rows the version writes lock, insert and read back. */
import { and, eq, type SQL } from 'drizzle-orm';

import { agentVersions } from '../schema/agent-versions.js';
import {
  AgentPermissions as AgentPermissionsSchema,
  AgentStoredPolicy as AgentStoredPolicySchema,
  agents,
  parseAgentPermissions,
  parseAgentPolicy,
  parseBuiltinKey,
} from '../schema/agents.js';
import type {
  AgentVersionRecord,
  ApplyAndPointInput,
  CreateAgentVersionInput,
  CreateAgentWithFirstVersionInput,
  MaterialisedAgent,
} from './agent-versions.js';
import {
  appliedRuntimeProfileId,
  VERSION_COLUMNS,
  type Transaction,
} from './agent-versions-shared.js';
import { Rollback } from './agent-versions-write-failures.js';
import type { AgentPermissions, AgentRecord, AgentStoredPolicy } from './agents.js';

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

/** An agent row as {@link AGENT_COLUMNS} reads it. */
interface AgentRow {
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
}

export function toAgentRecord(row: AgentRow): AgentRecord {
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

/** A materialised agent's permissions and policy, parsed before its transaction opens. */
interface ParsedSettings {
  readonly permissions: AgentPermissions;
  readonly policy: AgentStoredPolicy | null;
}

/** One `applyAndPoint` call, with its agent's settings parsed. */
export interface ApplyCall extends ParsedSettings {
  readonly agentId: string;
  readonly input: ApplyAndPointInput;
}

/** One `createAgentWithFirstVersion` call, with its agent's settings parsed. */
export interface CreateCall extends ParsedSettings {
  readonly input: CreateAgentWithFirstVersionInput;
}

export function parseMaterialised(materialised: MaterialisedAgent): ParsedSettings {
  return {
    permissions: AgentPermissionsSchema.parse(materialised.permissions),
    policy:
      materialised.policy === null ? null : AgentStoredPolicySchema.parse(materialised.policy),
  };
}

export const agentWhere = (workspaceId: string, agentId: string): SQL | undefined =>
  and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId));

/** Insert version `number` of `agentId` from `input`, answering the stored row. */
export async function insertVersionRow(
  tx: Transaction,
  {
    workspaceId,
    agentId,
    number,
  }: { readonly workspaceId: string; readonly agentId: string; readonly number: number },
  input: CreateAgentVersionInput,
): Promise<AgentVersionRecord> {
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
  return version;
}

/** Lock the agent's row, refusing one that is gone or archived. */
export async function lockLiveAgent(
  tx: Transaction,
  workspaceId: string,
  agentId: string,
): Promise<{ readonly runtimeProfileId: string | null }> {
  const locked = await tx
    .select({
      id: agents.id,
      runtimeProfileId: agents.runtimeProfileId,
      archivedAt: agents.archivedAt,
    })
    .from(agents)
    .where(agentWhere(workspaceId, agentId))
    .for('update');
  const current = locked[0];
  if (current === undefined) throw new Rollback({ kind: 'not-found' });
  // The handler refused an archived agent from a row it read before this lock; an archive
  // that committed in between is only visible here, on the locked row (issue #1987).
  if (current.archivedAt !== null) throw new Rollback({ kind: 'agent-archived' });
  return current;
}

/** Version `number` of `agentId`, or a `version-not-found` rollback. */
export async function versionNumbered(
  tx: Transaction,
  workspaceId: string,
  agentId: string,
  number: number,
): Promise<{ readonly id: string; readonly number: number; readonly body: unknown }> {
  const versions = await tx
    .select({ id: agentVersions.id, number: agentVersions.number, body: agentVersions.body })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.workspaceId, workspaceId),
        eq(agentVersions.agentId, agentId),
        eq(agentVersions.number, number),
      ),
    );
  const version = versions[0];
  if (version === undefined) throw new Rollback({ kind: 'version-not-found' });
  return version;
}

/**
 * The agent row once `version` is applied. The agent row is `local`'s working copy (issue #612):
 * another environment's move rewrites only its pointer, and answers the row as it is.
 */
export async function appliedAgentRow(
  tx: Transaction,
  workspaceId: string,
  { agentId, input, permissions, policy }: ApplyCall,
  applied: {
    readonly version: { readonly id: string; readonly body: unknown };
    readonly currentRuntimeProfileId: string | null;
  },
): Promise<AgentRow> {
  const { agent: materialised } = input;
  const rows =
    input.environment === 'local'
      ? await tx
          .update(agents)
          .set({
            name: materialised.name,
            instructions: materialised.instructions,
            model: materialised.model,
            modelConnectionId: materialised.references.modelConnectionId,
            runtimeProfileId: appliedRuntimeProfileId(
              applied.version.body,
              applied.currentRuntimeProfileId,
              materialised.references.runtimeProfileId,
            ),
            permissions: { ...permissions },
            policy,
            materialisedVersionId: applied.version.id,
          })
          .where(agentWhere(workspaceId, agentId))
          .returning(AGENT_COLUMNS)
      : await tx.select(AGENT_COLUMNS).from(agents).where(agentWhere(workspaceId, agentId));
  const row = rows[0];
  if (row === undefined) throw new Error('the locked agent row was not read back');
  return row;
}

export async function insertAgentRow(
  tx: Transaction,
  workspaceId: string,
  { input, permissions, policy }: CreateCall,
): Promise<AgentRow> {
  const { agent: materialised } = input;
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
  return agentRow;
}

/** Point the new agent's row at its first version, answering the updated row. */
export async function recordMaterialisedVersion(
  tx: Transaction,
  workspaceId: string,
  agentId: string,
  versionId: string,
): Promise<AgentRow> {
  const rows = await tx
    .update(agents)
    .set({ materialisedVersionId: versionId })
    .where(agentWhere(workspaceId, agentId))
    .returning(AGENT_COLUMNS);
  const row = rows[0];
  if (row === undefined) throw new Error('the new agent row was not updated');
  return row;
}
