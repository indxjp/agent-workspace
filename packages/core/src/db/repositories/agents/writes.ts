import { asc, eq } from 'drizzle-orm';

import { agents } from '../../schema/agents.js';
import { lockAgentCreations } from '../agent-versions-shared.js';
import type {
  AgentPermissions,
  AgentRecord,
  AgentRepository,
  AgentStoredPolicy,
  CreateAgentInput,
  CreateAgentOutcome,
  DeleteAgentOutcome,
  ReplaceAgentPolicyOutcome,
  UpdateAgentOutcome,
  UpdateAgentPatch,
} from '../agents.js';
import type { AgentContext } from './context.js';
import { AGENT_COLUMNS, selectAgent, toRecord, writeFailureOutcome } from './rows.js';

/** The agent's own reads and writes; the archive lifecycle is `./archive.ts`. */
export function createAgentWrites(
  context: AgentContext,
): Pick<AgentRepository, 'list' | 'get' | 'create' | 'update' | 'delete' | 'replacePolicy'> {
  return {
    list: () => listAgents(context),
    get: (id) => selectAgent(context, id),
    create: (input) => createAgent(context, input),
    update: (id, patch) => updateAgent(context, id, patch),
    delete: (id) => deleteAgent(context, id),
    replacePolicy: (id, policy) => replacePolicy(context, id, policy),
  };
}

async function listAgents({ db, tenant }: AgentContext): Promise<readonly AgentRecord[]> {
  const rows = await db
    .select(AGENT_COLUMNS)
    .from(agents)
    .where(tenant)
    // Total and stable, and identical to the in-memory store's documented order: oldest
    // first, ties broken by id. Without the second key two rows sharing a `created_at`
    // could come back in either order and a list test would be flaky rather than wrong.
    .orderBy(asc(agents.createdAt), asc(agents.id));
  return rows.map(toRecord);
}

async function createAgent(
  { db, checked }: AgentContext,
  input: CreateAgentInput,
): Promise<CreateAgentOutcome> {
  try {
    const rows = await db.transaction(async (tx) => {
      // The quota count reads `agents`, so a creation from any door waits its turn.
      await lockAgentCreations(tx, checked.workspaceId);
      return tx
        .insert(agents)
        .values({
          // Not from the caller. An insert cannot name a workspace; it inherits the scope's.
          workspaceId: checked.workspaceId,
          name: input.name,
          instructions: input.instructions,
          modelConnectionId: input.modelConnectionId,
          model: input.model,
          runtimeProfileId: input.runtimeProfileId ?? null,
          permissions: { ...input.permissions },
          ownerPrincipalId: input.ownerPrincipalId,
          createdBy: input.createdBy ?? null,
          createdByAgentId: input.createdByAgent?.agentId ?? null,
          createdByAgentVersion: input.createdByAgent?.version ?? null,
          createdByRunId: input.createdByAgent?.runId ?? null,
        })
        .returning(AGENT_COLUMNS);
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('the insert returned no row');
    }
    return { kind: 'created', agent: toRecord(row) };
  } catch (error) {
    return writeFailureOutcome(error, input);
  }
}

/** The columns an update writes: exactly the keys its patch carries. */
interface AgentChanges {
  name?: string;
  instructions?: string;
  modelConnectionId?: string | null;
  model?: string | null;
  runtimeProfileId?: string | null;
  permissions?: AgentPermissions;
}

/**
 * Only the keys the patch actually carries. `exactOptionalPropertyTypes` makes
 * `patch.name !== undefined` mean "the key was supplied", so a nullable column can be
 * set back to null without an absent key being read as one.
 */
function definedChanges(patch: UpdateAgentPatch): AgentChanges {
  const changes: AgentChanges = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.instructions !== undefined) changes.instructions = patch.instructions;
  if (patch.modelConnectionId !== undefined) changes.modelConnectionId = patch.modelConnectionId;
  if (patch.model !== undefined) changes.model = patch.model;
  if (patch.runtimeProfileId !== undefined) changes.runtimeProfileId = patch.runtimeProfileId;
  if (patch.permissions !== undefined) changes.permissions = { ...patch.permissions };
  return changes;
}

async function updateAgent(
  context: AgentContext,
  id: string,
  patch: UpdateAgentPatch,
): Promise<UpdateAgentOutcome> {
  const changes = definedChanges(patch);
  if (Object.keys(changes).length === 0) {
    // An empty patch must still answer not-found for an id this workspace does not have,
    // so it is a read rather than a no-op that reports success.
    const agent = await selectAgent(context, id);
    return agent === null ? { kind: 'not-found' } : { kind: 'updated', agent };
  }

  try {
    // An edit outside the version pipeline: the row no longer equals a version.
    const rows = await context.db
      .update(agents)
      .set({ ...changes, materialisedVersionId: null })
      .where(context.within(eq(agents.id, id)))
      .returning(AGENT_COLUMNS);
    const row = rows[0];
    // No row matched: either no such id, or the id belongs to another workspace. The two
    // are the same answer on purpose — see the header of `../agents.ts`.
    if (row === undefined) return { kind: 'not-found' };
    return { kind: 'updated', agent: toRecord(row) };
  } catch (error) {
    return writeFailureOutcome(error, patch);
  }
}

async function deleteAgent({ db, within }: AgentContext, id: string): Promise<DeleteAgentOutcome> {
  const rows = await db
    .delete(agents)
    .where(within(eq(agents.id, id)))
    .returning({ id: agents.id });
  return rows.length > 0 ? { kind: 'deleted' } : { kind: 'not-found' };
}

async function replacePolicy(
  { db, within }: AgentContext,
  id: string,
  policy: AgentStoredPolicy | null,
): Promise<ReplaceAgentPolicyOutcome> {
  const rows = await db
    .update(agents)
    .set({ policy, materialisedVersionId: null })
    .where(within(eq(agents.id, id)))
    .returning(AGENT_COLUMNS);
  const row = rows[0];
  return row === undefined ? { kind: 'not-found' } : { kind: 'updated', agent: toRecord(row) };
}
