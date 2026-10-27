/** Pieces of the agent version store shared by its read, query and write modules; see `./agent-versions.ts`. */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../client.js';
import { agentVersions } from '../schema/agent-versions.js';

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

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

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
