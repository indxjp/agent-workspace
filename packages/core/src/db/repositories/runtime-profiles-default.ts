import { eq, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { runtimeProfiles } from '../schema/runtime-profiles.js';
import { workspaces } from '../schema/workspaces.js';
import { attachDefaultToUnprofiledAgents } from './runtime-profiles-agents.js';
import { insertValues, RUNTIME_PROFILE_COLUMNS, toRecord } from './runtime-profiles-rows.js';
import type {
  CreateRuntimeProfileInput,
  EnsureWorkspaceDefaultOptions,
  EnsureWorkspaceDefaultRuntimeProfileOutcome,
} from './runtime-profiles-types.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome = EnsureWorkspaceDefaultRuntimeProfileOutcome;

/** The workspace-scoped inputs every step of an ensure shares. */
export interface EnsureContext {
  readonly workspaceId: string;
  readonly within: (rest: SQL) => SQL;
}

async function lockWorkspace(tx: Transaction, workspaceId: string): Promise<void> {
  const locked = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update');
  if (locked[0] === undefined) throw new Error('the scoped workspace does not exist');
}

async function selectOne(tx: Transaction, where: SQL) {
  const rows = await tx.select(RUNTIME_PROFILE_COLUMNS).from(runtimeProfiles).where(where).limit(1);
  return rows[0];
}

/**
 * The old default gives up its mark (one per workspace) and its agents, only once the new default
 * is certain to be written.
 */
async function unmarkReplacedDefault(
  tx: Transaction,
  ctx: EnsureContext,
  replacedId: string | null,
): Promise<void> {
  if (replacedId === null) return;
  await tx
    .update(runtimeProfiles)
    .set({ workspaceDefault: null })
    .where(ctx.within(eq(runtimeProfiles.id, replacedId)));
}

async function insertDefault(
  tx: Transaction,
  ctx: EnsureContext,
  input: CreateRuntimeProfileInput,
) {
  const inserted = await tx
    .insert(runtimeProfiles)
    .values({ ...insertValues(ctx.workspaceId, input), workspaceDefault: true })
    .returning(RUNTIME_PROFILE_COLUMNS);
  const row = inserted[0];
  if (row === undefined) throw new Error('the insert returned no row');
  return row;
}

async function markDefault(tx: Transaction, ctx: EnsureContext, profileId: string) {
  const marked = await tx
    .update(runtimeProfiles)
    .set({ workspaceDefault: true })
    .where(ctx.within(eq(runtimeProfiles.id, profileId)))
    .returning(RUNTIME_PROFILE_COLUMNS);
  const row = marked[0];
  if (row === undefined) throw new Error('the update returned no row');
  return row;
}

/** Move the replaced default's agents (if any) and the unprofiled agents onto the new default. */
async function attachNewDefault(
  tx: Transaction,
  ctx: EnsureContext,
  profileId: string,
  replacedId: string | null,
): Promise<void> {
  if (replacedId !== null) {
    await attachDefaultToUnprofiledAgents(tx, ctx.workspaceId, profileId, replacedId);
  }
  await attachDefaultToUnprofiledAgents(tx, ctx.workspaceId, profileId);
}

/** The body of `ensureWorkspaceDefault`, run inside one transaction. */
export async function ensureWorkspaceDefaultInTransaction(
  tx: Transaction,
  ctx: EnsureContext,
  input: CreateRuntimeProfileInput,
  options: EnsureWorkspaceDefaultOptions,
): Promise<Outcome> {
  // Serialise every ensure in this workspace: the second caller waits here and then
  // sees the first caller's default, so two concurrent calls leave one profile.
  await lockWorkspace(tx, ctx.workspaceId);

  const currentDefault = await selectOne(
    tx,
    ctx.within(eq(runtimeProfiles.workspaceDefault, true)),
  );
  const replacedId =
    currentDefault !== undefined &&
    currentDefault.name !== input.name &&
    options.replaceable?.(toRecord(currentDefault)) === true
      ? currentDefault.id
      : null;
  if (currentDefault !== undefined && replacedId === null) {
    await attachDefaultToUnprofiledAgents(tx, ctx.workspaceId, currentDefault.id);
    return { kind: 'kept', profile: toRecord(currentDefault) };
  }

  const existing = await selectOne(tx, ctx.within(eq(runtimeProfiles.name, input.name)));
  if (existing !== undefined && existing.driver !== input.driver) {
    return { kind: 'name-conflict', name: input.name };
  }

  if (existing === undefined) {
    await unmarkReplacedDefault(tx, ctx, replacedId);
    const row = await insertDefault(tx, ctx, input);
    await attachNewDefault(tx, ctx, row.id, replacedId);
    return { kind: 'created', profile: toRecord(row) };
  }

  if (!options.adoptable(toRecord(existing))) {
    return { kind: 'not-adoptable', profile: toRecord(existing) };
  }

  await unmarkReplacedDefault(tx, ctx, replacedId);
  const row = await markDefault(tx, ctx, existing.id);
  await attachNewDefault(tx, ctx, row.id, replacedId);
  return { kind: 'adopted', profile: toRecord(row) };
}
