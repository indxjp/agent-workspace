/**
 * The runtime-profile repository — spec §15.1's `RuntimeProfile`, persisted, tenant-scoped.
 *
 * Copies `./agents.ts`'s shape exactly (read that file's header first): a repository is obtained
 * *for a {@link WorkspaceScope}*, no method on it takes a workspace id, and a write failure is
 * classified into a named outcome rather than re-thrown as an opaque error.
 *
 * ## Outcomes
 *
 *   * `name-conflict` — `runtime_profiles_workspace_name_key`, unique on `(workspace_id, name)`.
 *   * `unknown-runtime-connection` — either half of the tenant-paired reference to `secrets.id`
 *     (see `../schema/runtime-profiles.ts`'s header for why a runtime connection is a secret).
 *   * `not-found` — including "that id belongs to another workspace" (§25: reported as absent,
 *     never as forbidden — a 403 would be an existence oracle across the tenant boundary).
 *
 * ## The workspace default (issue #504, S1-22)
 *
 * The profile whose `workspace_default` is `true` (at most one per workspace) is the one an agent
 * version with `runtimeProfileName: null` resolves to when it is applied.
 * {@link RuntimeProfileRepository.findWorkspaceDefault} reads it;
 * {@link RuntimeProfileRepository.ensureWorkspaceDefault} makes sure one exists without replacing
 * a default someone already chose (only a caller's `replaceable` swaps a default it owns). Nothing here picks a default implicitly: a workspace
 * on which `ensureWorkspaceDefault` never ran has none.
 *
 * Once a workspace has a default, `ensureWorkspaceDefault` also attaches it to every agent that is
 * still exactly what a version naming no runtime profile materialised, but whose row has none: an
 * agent applied before the workspace had a default, or whose default was deleted (the agents
 * foreign key sets it to `NULL`). See `attachDefaultToUnprofiledAgents`.
 */
import { asc, eq, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { runtimeProfiles } from '../schema/runtime-profiles.js';
import { ensureWorkspaceDefaultInTransaction } from './runtime-profiles-default.js';
import {
  classifyWriteFailure,
  insertValues,
  patchChanges,
  RUNTIME_PROFILE_COLUMNS,
  toRecord,
  workspacePredicates,
} from './runtime-profiles-rows.js';
import type {
  CreateRuntimeProfileInput,
  CreateRuntimeProfileOutcome,
  DeleteRuntimeProfileOutcome,
  EnsureWorkspaceDefaultOptions,
  EnsureWorkspaceDefaultRuntimeProfileOutcome,
  RuntimeProfileRecord,
  RuntimeProfileRepository,
  RuntimeProfileRepositoryProvider,
  UpdateRuntimeProfileOutcome,
  UpdateRuntimeProfilePatch,
} from './runtime-profiles-types.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export type {
  CreateRuntimeProfileInput,
  CreateRuntimeProfileOutcome,
  DeleteRuntimeProfileOutcome,
  EnsureWorkspaceDefaultOptions,
  EnsureWorkspaceDefaultRuntimeProfileOutcome,
  RuntimeProfileRecord,
  RuntimeProfileRepository,
  RuntimeProfileRepositoryProvider,
  UpdateRuntimeProfileOutcome,
  UpdateRuntimeProfilePatch,
} from './runtime-profiles-types.js';

/** The PostgreSQL {@link RuntimeProfileRepositoryProvider}. See `./agents.ts` for the shape. */
export function createDatabaseRuntimeProfileRepositoryProvider(
  db: Database,
): RuntimeProfileRepositoryProvider {
  return {
    forScope: (scope: WorkspaceScope) => createScopedRepository(db, scope),
  };
}

function createScopedRepository(db: Database, scope: WorkspaceScope): RuntimeProfileRepository {
  const checked = requireWorkspaceScope(scope, 'RuntimeProfileRepositoryProvider');
  const { tenant, within } = workspacePredicates(checked.workspaceId);

  async function selectOne(where: SQL): Promise<RuntimeProfileRecord | null> {
    const rows = await db
      .select(RUNTIME_PROFILE_COLUMNS)
      .from(runtimeProfiles)
      .where(where)
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  return {
    async list(): Promise<readonly RuntimeProfileRecord[]> {
      const rows = await db
        .select(RUNTIME_PROFILE_COLUMNS)
        .from(runtimeProfiles)
        .where(tenant)
        .orderBy(asc(runtimeProfiles.createdAt), asc(runtimeProfiles.id));
      return rows.map(toRecord);
    },

    get: (id: string) => selectOne(within(eq(runtimeProfiles.id, id))),

    async create(input: CreateRuntimeProfileInput): Promise<CreateRuntimeProfileOutcome> {
      try {
        const rows = await db
          .insert(runtimeProfiles)
          .values(insertValues(checked.workspaceId, input))
          .returning(RUNTIME_PROFILE_COLUMNS);
        const row = rows[0];
        if (row === undefined) throw new Error('the insert returned no row');
        return { kind: 'created', profile: toRecord(row) };
      } catch (error) {
        const classified = classifyWriteFailure(error);
        if (classified === 'name-conflict') return { kind: 'name-conflict', name: input.name };
        if (classified === 'unknown-runtime-connection') {
          return {
            kind: 'unknown-runtime-connection',
            runtimeConnectionId: input.runtimeConnectionId ?? '',
          };
        }
        throw error;
      }
    },

    async update(
      id: string,
      patch: UpdateRuntimeProfilePatch,
    ): Promise<UpdateRuntimeProfileOutcome> {
      const changes = patchChanges(patch);
      if (Object.keys(changes).length === 0) {
        const profile = await selectOne(within(eq(runtimeProfiles.id, id)));
        return profile === null ? { kind: 'not-found' } : { kind: 'updated', profile };
      }
      try {
        const rows = await db
          .update(runtimeProfiles)
          .set(changes)
          .where(within(eq(runtimeProfiles.id, id)))
          .returning(RUNTIME_PROFILE_COLUMNS);
        const row = rows[0];
        if (row === undefined) return { kind: 'not-found' };
        return { kind: 'updated', profile: toRecord(row) };
      } catch (error) {
        const classified = classifyWriteFailure(error);
        if (classified === 'name-conflict') {
          return { kind: 'name-conflict', name: patch.name ?? '' };
        }
        if (classified === 'unknown-runtime-connection') {
          return {
            kind: 'unknown-runtime-connection',
            runtimeConnectionId: patch.runtimeConnectionId ?? '',
          };
        }
        throw error;
      }
    },

    async delete(id: string): Promise<DeleteRuntimeProfileOutcome> {
      const rows = await db
        .delete(runtimeProfiles)
        .where(within(eq(runtimeProfiles.id, id)))
        .returning({ id: runtimeProfiles.id });
      return rows.length > 0 ? { kind: 'deleted' } : { kind: 'not-found' };
    },

    findWorkspaceDefault: () => selectOne(within(eq(runtimeProfiles.workspaceDefault, true))),

    async ensureWorkspaceDefault(
      input: CreateRuntimeProfileInput,
      options: EnsureWorkspaceDefaultOptions,
    ): Promise<EnsureWorkspaceDefaultRuntimeProfileOutcome> {
      try {
        return await db.transaction((tx) =>
          ensureWorkspaceDefaultInTransaction(
            tx,
            { workspaceId: checked.workspaceId, within },
            input,
            options,
          ),
        );
      } catch (error) {
        // A plain `create` of the same name committed between our read and our insert.
        if (classifyWriteFailure(error) === 'name-conflict') {
          return { kind: 'name-conflict', name: input.name };
        }
        throw error;
      }
    },
  };
}
