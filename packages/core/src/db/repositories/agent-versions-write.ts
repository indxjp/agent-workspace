/** The write half of the agent version store; see `./agent-versions.ts`. */
import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentVersions } from '../schema/agent-versions.js';
import { auditEvents } from '../schema/audit-events.js';
import { agents } from '../schema/agents.js';
import type {
  AgentVersionRecord,
  AgentVersionRepository,
  ApplyAndPointInput,
  ApplyAndPointOutcome,
  CreateAgentVersionInput,
  CreateAgentVersionOutcome,
  CreateAgentWithFirstVersionInput,
  CreateAgentWithFirstVersionOutcome,
} from './agent-versions.js';
import { subagentLookups } from './agent-versions-query.js';
import { narrowStorageGrants } from './agent-versions-resolution.js';
import { bodySubagentNames, type Transaction } from './agent-versions-shared.js';
import {
  actorOf,
  assignmentWrites,
  type AssignmentWrites,
} from './agent-versions-write-assignments.js';
import {
  createAgentFailure,
  createVersionFailure,
  referenceGoneOrNameConflict,
  Rollback,
} from './agent-versions-write-failures.js';
import { pointerWrites, type PointerWrites } from './agent-versions-write-pointers.js';
import {
  agentWhere,
  appliedAgentRow,
  insertAgentRow,
  insertVersionRow,
  lockLiveAgent,
  parseMaterialised,
  recordMaterialisedVersion,
  toAgentRecord,
  versionNumbered,
  type ApplyCall,
  type CreateCall,
} from './agent-versions-write-rows.js';
import { checkedAuditEvent } from './audit-events.js';

type SubagentNestingCheck = (
  tx: Transaction,
  agentId: string | null,
  name: string,
  body: unknown,
) => Promise<void>;

/** What every write of one workspace's version store shares. */
interface WriteContext {
  readonly db: Database;
  readonly workspaceId: string;
  readonly pointers: PointerWrites;
  readonly assignments: AssignmentWrites;
  readonly checkSubagentNesting: SubagentNestingCheck;
}

/**
 * The agents this workspace created since `since`, whoever made them: the one count behind the
 * quota rule and the in-transaction re-check, so they cannot disagree. It counts `agents` rows,
 * as a console create writes no `agent-created` audit row.
 */
async function countCreatedSince(
  executor: Pick<Transaction, 'select'>,
  workspaceId: string,
  since: Date,
): Promise<number> {
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
}

/**
 * One level of subagents, both ways, for the version `agentId` (`null`: not created yet) is
 * about to materialise under `name`. Takes the workspace's subagent lock first, so it must
 * run in the materialising transaction. A body without subagents creates no edge: no lock,
 * no check.
 */
function subagentNestingCheck(workspaceId: string): SubagentNestingCheck {
  const { candidatesByName, parentsOf } = subagentLookups(workspaceId);
  return async (tx, agentId, name, body) => {
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
}

async function createVersion(
  { db, workspaceId, assignments }: WriteContext,
  agentId: string,
  input: CreateAgentVersionInput,
): Promise<CreateAgentVersionOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(agentWhere(workspaceId, agentId))
        .for('update');
      if (locked[0] === undefined) return { kind: 'not-found' };
      const next = await tx
        .select({
          number: sql`coalesce(max(${agentVersions.number}), 0) + 1`.mapWith(Number),
        })
        .from(agentVersions)
        .where(and(eq(agentVersions.workspaceId, workspaceId), eq(agentVersions.agentId, agentId)));
      const number = next[0]?.number ?? 1;
      if (input.number !== undefined && input.number !== number) return { kind: 'number-taken' };
      const version = await insertVersionRow(tx, { workspaceId, agentId, number }, input);
      await assignments.writeVersionStorageGrants(tx, version.id, input.storageGrants ?? []);
      return { kind: 'created', version };
    });
  } catch (error) {
    return createVersionFailure(error);
  }
}

async function applyInTransaction(
  ctx: WriteContext,
  tx: Transaction,
  call: ApplyCall,
): Promise<ApplyAndPointOutcome> {
  const { workspaceId, pointers } = ctx;
  const { agentId, input, permissions } = call;
  const { agent: materialised, environment, audit } = input;
  const target = { agentId, environment };
  await pointers.lockPointers(tx, environment);
  const current = await lockLiveAgent(tx, workspaceId, agentId);
  if (input.expectedVersion !== undefined) {
    const pointed = await pointers.pointedNumber(tx, target);
    if (pointed !== input.expectedVersion) {
      throw new Rollback({ kind: 'pointer-moved', current: pointed });
    }
  }
  const version = await versionNumbered(tx, workspaceId, agentId, input.number);
  if (environment === 'local') {
    await ctx.checkSubagentNesting(tx, agentId, materialised.name, version.body);
  }
  const row = await appliedAgentRow(tx, workspaceId, call, {
    version,
    currentRuntimeProfileId: current.runtimeProfileId,
  });
  if (environment === 'local') {
    const { references } = materialised;
    await ctx.assignments.writeAssignments(tx, agentId, { permissions, references, audit });
  }
  const pointer = await pointers.pointAndCheckSurface(tx, target, version, {
    reason: input.reason,
    movedBy: audit.actorPrincipalId,
  });
  await tx.insert(auditEvents).values({
    workspaceId,
    action: 'agent-changed',
    subjectId: agentId,
    subjectLabel: audit.subjectLabel,
    ...actorOf(audit),
  });
  return { kind: 'applied', agent: toAgentRecord(row), pointer };
}

async function applyAndPoint(
  ctx: WriteContext,
  agentId: string,
  input: ApplyAndPointInput,
): Promise<ApplyAndPointOutcome> {
  const call: ApplyCall = { agentId, input, ...parseMaterialised(input.agent) };
  try {
    return await ctx.db.transaction((tx) => applyInTransaction(ctx, tx, call));
  } catch (error) {
    if (error instanceof Rollback) return error.outcome;
    return referenceGoneOrNameConflict(error, input.agent.name);
  }
}

/** Write the `agent-created` row `input.agentCreatedAudit` asks for, if any. */
async function insertAgentCreatedAudit(
  tx: Transaction,
  workspaceId: string,
  input: CreateAgentWithFirstVersionInput,
  created: { readonly agentId: string; readonly version: AgentVersionRecord },
): Promise<void> {
  if (input.agentCreatedAudit === undefined) return;
  const { details, ...actor } = input.agentCreatedAudit;
  await tx.insert(auditEvents).values(
    checkedAuditEvent({
      ...actor,
      workspaceId,
      action: 'agent-created',
      subjectId: created.agentId,
      subjectLabel: input.agent.name,
      details: {
        ...details,
        agentId: created.agentId,
        version: created.version.number,
        via: input.version.via,
      },
    }),
  );
}

async function createInTransaction(
  ctx: WriteContext,
  tx: Transaction,
  call: CreateCall,
): Promise<CreateAgentWithFirstVersionOutcome> {
  const { workspaceId, pointers, assignments } = ctx;
  const { input, permissions } = call;
  const { agent: materialised, environment, version: versionInput } = input;
  const { references } = materialised;
  // Every create uses FIRST_ENVIRONMENT ('local'), and a console create takes the same lock
  // (`lockAgentCreations`), so this serialises every creation in the workspace: the quota
  // count below cannot race.
  await pointers.lockPointers(tx, environment);
  if (
    input.quota !== undefined &&
    (await countCreatedSince(tx, workspaceId, input.quota.since)) >= input.quota.limit
  ) {
    // Nothing has been written, so returning commits only the lock release.
    return { kind: 'quota-exceeded' };
  }
  await ctx.checkSubagentNesting(tx, null, materialised.name, versionInput.body);
  const { id: agentId } = await insertAgentRow(tx, workspaceId, call);
  await assignments.writeAssignments(tx, agentId, { permissions, references, audit: input.audit });
  const version = await insertVersionRow(tx, { workspaceId, agentId, number: 1 }, versionInput);
  await assignments.writeVersionStorageGrants(
    tx,
    version.id,
    narrowStorageGrants(references.storageGrants ?? [], permissions),
  );
  // The version needs the agent's id, so the row learns its version second.
  const materialisedRow = await recordMaterialisedVersion(tx, workspaceId, agentId, version.id);
  const pointer = await pointers.pointAndCheckSurface(tx, { agentId, environment }, version, {
    reason: 'set',
    movedBy: versionInput.createdByPrincipalId,
  });
  await insertAgentCreatedAudit(tx, workspaceId, input, { agentId, version });
  return { kind: 'created', agent: toAgentRecord(materialisedRow), version, pointer };
}

async function createAgentWithFirstVersion(
  ctx: WriteContext,
  input: CreateAgentWithFirstVersionInput,
): Promise<CreateAgentWithFirstVersionOutcome> {
  const call: CreateCall = { input, ...parseMaterialised(input.agent) };
  try {
    return await ctx.db.transaction((tx) => createInTransaction(ctx, tx, call));
  } catch (error) {
    return createAgentFailure(error, input.agent.name);
  }
}

export function agentVersionWrites(
  db: Database,
  workspaceId: string,
): Pick<
  AgentVersionRepository,
  'create' | 'applyAndPoint' | 'createAgentWithFirstVersion' | 'agentsCreatedSince'
> {
  const ctx: WriteContext = {
    db,
    workspaceId,
    pointers: pointerWrites(workspaceId),
    assignments: assignmentWrites(workspaceId),
    checkSubagentNesting: subagentNestingCheck(workspaceId),
  };
  return {
    agentsCreatedSince: (since) => countCreatedSince(db, workspaceId, since),
    create: (agentId, input) => createVersion(ctx, agentId, input),
    applyAndPoint: (agentId, input) => applyAndPoint(ctx, agentId, input),
    createAgentWithFirstVersion: (input) => createAgentWithFirstVersion(ctx, input),
  };
}
