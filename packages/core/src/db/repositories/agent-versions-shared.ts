/** Pieces of the agent version store shared by its read, query and write modules; see `./agent-versions.ts`. */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../client.js';
import { agentVersions } from '../schema/agent-versions.js';

// Defined in a database-free module so `@agent-workspace/core/db-model` can carry them.
export {
  appliedRuntimeProfileId,
  bodyDeclaresSubagents,
  bodyHasDescription,
  bodySubagentNames,
} from './agent-versions-body.js';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

/** Serialise every pointer write in one workspace and environment (C9), until the transaction ends. */
export async function lockPointerWrites(
  tx: Transaction,
  workspaceId: string,
  environment: string,
): Promise<void> {
  const key = `agent_version_pointers:${workspaceId}:${environment}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Serialise every agent creation in one workspace. A creation from a version points `local` at its
 * first version, so it takes that pointer lock; a console create takes the same one, so the quota
 * count that runs under it cannot miss a console-made agent.
 */
export const lockAgentCreations = (tx: Transaction, workspaceId: string): Promise<void> =>
  lockPointerWrites(tx, workspaceId, 'local');

export const VERSION_COLUMNS = {
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
export function surfacesOf(alias: string): SQL {
  const column = sql.raw(`${alias}.body`);
  return sql`case when jsonb_typeof(${column}->'surfaces') = 'array' then ${column}->'surfaces' else '[]'::jsonb end`;
}

export const ConflictRow = z.object({ name: z.string() });
