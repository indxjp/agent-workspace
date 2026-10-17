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
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { workspaces } from '../schema/workspaces.js';
import {
  runtimeProfiles,
  type NewRuntimeProfileRow,
  type RuntimeProfileDriver,
  type RuntimeProfileFilesystem,
  type RuntimeProfileNetworkPolicy,
} from '../schema/runtime-profiles.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

/** One `runtime_profiles` row, with `timestamptz` columns as `Date`. */
export interface RuntimeProfileRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly driver: RuntimeProfileDriver;
  readonly runtimeConnectionId: string | null;
  readonly cpu: number | null;
  readonly memoryMb: number | null;
  readonly diskMb: number | null;
  readonly networkPolicy: RuntimeProfileNetworkPolicy;
  readonly allowedDomains: readonly string[] | null;
  readonly filesystem: RuntimeProfileFilesystem;
  readonly persistPaths: readonly string[] | null;
  readonly timeoutSeconds: number | null;
  readonly idleTimeoutSeconds: number | null;
  readonly driverConfig: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything an insert supplies. The workspace is not among them — it comes from the scope. */
export interface CreateRuntimeProfileInput {
  readonly name: string;
  readonly driver: RuntimeProfileDriver;
  readonly runtimeConnectionId: string | null;
  readonly cpu: number | null;
  readonly memoryMb: number | null;
  readonly diskMb: number | null;
  readonly networkPolicy: RuntimeProfileNetworkPolicy;
  readonly allowedDomains: readonly string[] | null;
  readonly filesystem: RuntimeProfileFilesystem;
  readonly persistPaths: readonly string[] | null;
  readonly timeoutSeconds: number | null;
  readonly idleTimeoutSeconds: number | null;
  readonly driverConfig: Record<string, unknown> | null;
}

/** Everything an update may change. An absent key is "leave it alone". */
export type UpdateRuntimeProfilePatch = Partial<CreateRuntimeProfileInput>;

export type CreateRuntimeProfileOutcome =
  | { readonly kind: 'created'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-runtime-connection'; readonly runtimeConnectionId: string };

export type UpdateRuntimeProfileOutcome =
  | { readonly kind: 'updated'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-runtime-connection'; readonly runtimeConnectionId: string };

export type DeleteRuntimeProfileOutcome =
  { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/**
 * What {@link RuntimeProfileRepository.ensureWorkspaceDefault} did.
 *
 *   * `kept` — the workspace already had a default; it is returned unchanged and not replaced
 *     (only the caller's `replaceable` can let `adopted` or `created` replace it).
 *   * `adopted` — a profile with `input.name` and `input.driver` already existed and the caller's
 *     `adoptable` accepted it; it is now the default, and its other settings are left as they were
 *     (only `updatedAt` moves).
 *   * `created` — no such profile existed; it was inserted and made the default.
 *   * `name-conflict` — a profile named `input.name` exists with another driver. Nothing was
 *     written, and the workspace still has no default.
 *   * `not-adoptable` — a profile with `input.name` and `input.driver` exists, but the caller's
 *     `adoptable` refused it (`profile` is that profile, unchanged). Nothing was written, and the
 *     workspace still has no default.
 *
 * After `kept`, `adopted` and `created`, the default has also been attached, in the same
 * transaction, to the agents that should already carry it (see the module comment).
 */
export type EnsureWorkspaceDefaultRuntimeProfileOutcome =
  | { readonly kind: 'kept'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'adopted'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'created'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'not-adoptable'; readonly profile: RuntimeProfileRecord };

/** How {@link RuntimeProfileRepository.ensureWorkspaceDefault} treats a profile that already exists. */
export interface EnsureWorkspaceDefaultOptions {
  /**
   * Whether an existing profile with the input's name and driver may become the default. The
   * repository does not know what a driver can enforce; the caller does.
   */
  readonly adoptable: (existing: RuntimeProfileRecord) => boolean;
  /**
   * Whether the current default, when it is not the input's profile, may be replaced by it. Unset,
   * a default is never replaced. When it answers `true` and the input's profile is created or
   * adopted, the old default loses the mark and every agent that carried it only because it was
   * the default (see `attachDefaultToUnprofiledAgents`) moves to the new one. The local runtime uses
   * it to swap its own `local` and `docker` profiles between sessions (#786).
   */
  readonly replaceable?: (currentDefault: RuntimeProfileRecord) => boolean;
}

/** Runtime-profile persistence for exactly one workspace. No method takes a workspace id. */
export interface RuntimeProfileRepository {
  /** Every profile in this workspace, oldest first, ties broken by id. */
  list(): Promise<readonly RuntimeProfileRecord[]>;
  get(id: string): Promise<RuntimeProfileRecord | null>;
  create(input: CreateRuntimeProfileInput): Promise<CreateRuntimeProfileOutcome>;
  update(id: string, patch: UpdateRuntimeProfilePatch): Promise<UpdateRuntimeProfileOutcome>;
  delete(id: string): Promise<DeleteRuntimeProfileOutcome>;
  /** This workspace's default runtime profile, or `null` when it has chosen none. */
  findWorkspaceDefault(): Promise<RuntimeProfileRecord | null>;
  /**
   * Make sure this workspace has a default runtime profile, in one transaction that first locks
   * the workspace row, so concurrent calls serialise and leave exactly one profile. See
   * {@link EnsureWorkspaceDefaultRuntimeProfileOutcome} for the answers. A `runtimeConnectionId`
   * that is not this workspace's is not an outcome here: the call rejects (ADR-0015).
   */
  ensureWorkspaceDefault(
    input: CreateRuntimeProfileInput,
    options: EnsureWorkspaceDefaultOptions,
  ): Promise<EnsureWorkspaceDefaultRuntimeProfileOutcome>;
}

export interface RuntimeProfileRepositoryProvider {
  forScope(scope: WorkspaceScope): RuntimeProfileRepository;
}

/** Transcribed from `migrations/`, which is the artefact PostgreSQL actually reports. */
const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set([
  'runtime_profiles_workspace_name_key',
]);
const RUNTIME_CONNECTION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'runtime_profiles_runtime_connection_id_secrets_id_fk',
  'runtime_profiles_runtime_connection_workspace_fk',
]);

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function classifyWriteFailure(
  error: unknown,
): 'name-conflict' | 'unknown-runtime-connection' | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return 'name-conflict';
    }
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      RUNTIME_CONNECTION_CONSTRAINTS.has(failure.constraint)
    ) {
      return 'unknown-runtime-connection';
    }
  }
  return null;
}

const RUNTIME_PROFILE_COLUMNS = {
  id: runtimeProfiles.id,
  workspaceId: runtimeProfiles.workspaceId,
  name: runtimeProfiles.name,
  driver: runtimeProfiles.driver,
  runtimeConnectionId: runtimeProfiles.runtimeConnectionId,
  cpu: runtimeProfiles.cpu,
  memoryMb: runtimeProfiles.memoryMb,
  diskMb: runtimeProfiles.diskMb,
  networkPolicy: runtimeProfiles.networkPolicy,
  allowedDomains: runtimeProfiles.allowedDomains,
  filesystem: runtimeProfiles.filesystem,
  persistPaths: runtimeProfiles.persistPaths,
  timeoutSeconds: runtimeProfiles.timeoutSeconds,
  idleTimeoutSeconds: runtimeProfiles.idleTimeoutSeconds,
  driverConfig: runtimeProfiles.driverConfig,
  createdAt: runtimeProfiles.createdAt,
  updatedAt: runtimeProfiles.updatedAt,
} as const;

type SelectedRow = {
  id: string;
  workspaceId: string;
  name: string;
  driver: string;
  runtimeConnectionId: string | null;
  cpu: number | null;
  memoryMb: number | null;
  diskMb: number | null;
  networkPolicy: string;
  allowedDomains: unknown;
  filesystem: string;
  persistPaths: unknown;
  timeoutSeconds: number | null;
  idleTimeoutSeconds: number | null;
  driverConfig: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** A jsonb array-or-null column, read as `readonly string[] | null` without trusting the type. */
function toStringArrayOrNull(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }
  throw new Error('a runtime_profiles jsonb array column did not hold an array of strings');
}

function toRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('runtime_profiles.driver_config did not hold a JSON object');
}

/** The insert values for `input` in `workspaceId`; shared by `create` and `ensureWorkspaceDefault`. */
function insertValues(workspaceId: string, input: CreateRuntimeProfileInput): NewRuntimeProfileRow {
  return {
    workspaceId,
    name: input.name,
    driver: input.driver,
    runtimeConnectionId: input.runtimeConnectionId,
    cpu: input.cpu,
    memoryMb: input.memoryMb,
    diskMb: input.diskMb,
    networkPolicy: input.networkPolicy,
    allowedDomains: input.allowedDomains ? [...input.allowedDomains] : null,
    filesystem: input.filesystem,
    persistPaths: input.persistPaths ? [...input.persistPaths] : null,
    timeoutSeconds: input.timeoutSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    driverConfig: input.driverConfig ? { ...input.driverConfig } : null,
  };
}

/** What a database transaction offers that the attach below needs. */
type Executor = Pick<Database, 'execute'>;

/**
 * Attach `profileId`, the workspace's default, to every agent of `workspaceId` the default should
 * already be on (issue #504, S1-22 review): the agent row has no runtime profile, every version
 * pointed at it names none (`definition.agent.runtimeProfileName` is JSON `null`), and the row was
 * not edited after a pointer moved (`agents.materialised_version_id = agent_version_pointers.version_id`).
 * Applying that version again now would write exactly this, so it is the same materialisation, not
 * a new choice.
 *
 * `materialised_version_id` and `updated_at` are deliberately left alone: the row still equals its
 * pointed version. An agent that was never pointed, was edited by hand after its pointer moved, or
 * whose version names a profile is not touched.
 */
async function attachDefaultToUnprofiledAgents(
  tx: Executor,
  workspaceId: string,
  profileId: string,
  /** The default being replaced: its agents move instead of the ones with no profile. */
  replacedDefaultId: string | null = null,
): Promise<void> {
  const carried =
    replacedDefaultId === null
      ? sql`a.runtime_profile_id is null`
      : sql`a.runtime_profile_id = ${replacedDefaultId}`;
  await tx.execute(sql`
    update agents a
       set runtime_profile_id = ${profileId}
     where a.workspace_id = ${workspaceId}
       and ${carried}
       and exists (
         select 1
           from agent_version_pointers p
           join agent_versions v on v.id = p.version_id and v.workspace_id = p.workspace_id
          where p.workspace_id = ${workspaceId}
            and p.agent_id = a.id
            and jsonb_typeof(v.body #> array['definition', 'agent', 'runtimeProfileName']) = 'null'
            and a.materialised_version_id = p.version_id
       )
       and not exists (
         select 1
           from agent_version_pointers p
           join agent_versions v on v.id = p.version_id and v.workspace_id = p.workspace_id
          where p.workspace_id = ${workspaceId}
            and p.agent_id = a.id
            and jsonb_typeof(v.body #> array['definition', 'agent', 'runtimeProfileName'])
                is distinct from 'null'
       )
  `);
}

function toRecord(row: SelectedRow): RuntimeProfileRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    driver: row.driver as RuntimeProfileDriver,
    runtimeConnectionId: row.runtimeConnectionId,
    cpu: row.cpu,
    memoryMb: row.memoryMb,
    diskMb: row.diskMb,
    networkPolicy: row.networkPolicy as RuntimeProfileNetworkPolicy,
    allowedDomains: toStringArrayOrNull(row.allowedDomains),
    filesystem: row.filesystem as RuntimeProfileFilesystem,
    persistPaths: toStringArrayOrNull(row.persistPaths),
    timeoutSeconds: row.timeoutSeconds,
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    driverConfig: toRecordOrNull(row.driverConfig),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The PostgreSQL {@link RuntimeProfileRepositoryProvider}. See `./agents.ts` for the shape. */
export function createDatabaseRuntimeProfileRepositoryProvider(
  db: Database,
): RuntimeProfileRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): RuntimeProfileRepository {
      const checked = requireWorkspaceScope(scope, 'RuntimeProfileRepositoryProvider');
      const tenant = eq(runtimeProfiles.workspaceId, checked.workspaceId);
      const within = (rest: SQL): SQL => {
        const combined = and(tenant, rest);
        if (combined === undefined) throw new Error('the workspace predicate could not be built');
        return combined;
      };

      return {
        async list(): Promise<readonly RuntimeProfileRecord[]> {
          const rows = await db
            .select(RUNTIME_PROFILE_COLUMNS)
            .from(runtimeProfiles)
            .where(tenant)
            .orderBy(asc(runtimeProfiles.createdAt), asc(runtimeProfiles.id));
          return rows.map(toRecord);
        },

        async get(id: string): Promise<RuntimeProfileRecord | null> {
          const rows = await db
            .select(RUNTIME_PROFILE_COLUMNS)
            .from(runtimeProfiles)
            .where(within(eq(runtimeProfiles.id, id)))
            .limit(1);
          const row = rows[0];
          return row === undefined ? null : toRecord(row);
        },

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
          const changes: Record<string, unknown> = {};
          if (patch.name !== undefined) changes['name'] = patch.name;
          if (patch.driver !== undefined) changes['driver'] = patch.driver;
          if (patch.runtimeConnectionId !== undefined) {
            changes['runtimeConnectionId'] = patch.runtimeConnectionId;
          }
          if (patch.cpu !== undefined) changes['cpu'] = patch.cpu;
          if (patch.memoryMb !== undefined) changes['memoryMb'] = patch.memoryMb;
          if (patch.diskMb !== undefined) changes['diskMb'] = patch.diskMb;
          if (patch.networkPolicy !== undefined) changes['networkPolicy'] = patch.networkPolicy;
          if (patch.allowedDomains !== undefined) {
            changes['allowedDomains'] = patch.allowedDomains ? [...patch.allowedDomains] : null;
          }
          if (patch.filesystem !== undefined) changes['filesystem'] = patch.filesystem;
          if (patch.persistPaths !== undefined) {
            changes['persistPaths'] = patch.persistPaths ? [...patch.persistPaths] : null;
          }
          if (patch.timeoutSeconds !== undefined) changes['timeoutSeconds'] = patch.timeoutSeconds;
          if (patch.idleTimeoutSeconds !== undefined) {
            changes['idleTimeoutSeconds'] = patch.idleTimeoutSeconds;
          }
          if (patch.driverConfig !== undefined) {
            changes['driverConfig'] = patch.driverConfig ? { ...patch.driverConfig } : null;
          }

          if (Object.keys(changes).length === 0) {
            const rows = await db
              .select(RUNTIME_PROFILE_COLUMNS)
              .from(runtimeProfiles)
              .where(within(eq(runtimeProfiles.id, id)))
              .limit(1);
            const row = rows[0];
            return row === undefined
              ? { kind: 'not-found' }
              : { kind: 'updated', profile: toRecord(row) };
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

        async findWorkspaceDefault(): Promise<RuntimeProfileRecord | null> {
          const rows = await db
            .select(RUNTIME_PROFILE_COLUMNS)
            .from(runtimeProfiles)
            .where(within(eq(runtimeProfiles.workspaceDefault, true)))
            .limit(1);
          const row = rows[0];
          return row === undefined ? null : toRecord(row);
        },

        async ensureWorkspaceDefault(
          input: CreateRuntimeProfileInput,
          options: EnsureWorkspaceDefaultOptions,
        ): Promise<EnsureWorkspaceDefaultRuntimeProfileOutcome> {
          try {
            return await db.transaction(
              async (tx): Promise<EnsureWorkspaceDefaultRuntimeProfileOutcome> => {
                // Serialise every ensure in this workspace: the second caller waits here and then
                // sees the first caller's default, so two concurrent calls leave one profile.
                const locked = await tx
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, checked.workspaceId))
                  .for('update');
                if (locked[0] === undefined) throw new Error('the scoped workspace does not exist');

                const current = await tx
                  .select(RUNTIME_PROFILE_COLUMNS)
                  .from(runtimeProfiles)
                  .where(within(eq(runtimeProfiles.workspaceDefault, true)))
                  .limit(1);
                const currentDefault = current[0];
                const replacedId =
                  currentDefault !== undefined &&
                  currentDefault.name !== input.name &&
                  options.replaceable?.(toRecord(currentDefault)) === true
                    ? currentDefault.id
                    : null;
                if (currentDefault !== undefined && replacedId === null) {
                  await attachDefaultToUnprofiledAgents(tx, checked.workspaceId, currentDefault.id);
                  return { kind: 'kept', profile: toRecord(currentDefault) };
                }
                // The old default gives up its mark (one per workspace) and its agents, only once
                // the new default is certain to be written.
                const takeOverReplacedDefault = async (profileId: string): Promise<void> => {
                  if (replacedId === null) return;
                  await attachDefaultToUnprofiledAgents(
                    tx,
                    checked.workspaceId,
                    profileId,
                    replacedId,
                  );
                };
                const unmarkReplacedDefault = async (): Promise<void> => {
                  if (replacedId === null) return;
                  await tx
                    .update(runtimeProfiles)
                    .set({ workspaceDefault: null })
                    .where(within(eq(runtimeProfiles.id, replacedId)));
                };

                const named = await tx
                  .select(RUNTIME_PROFILE_COLUMNS)
                  .from(runtimeProfiles)
                  .where(within(eq(runtimeProfiles.name, input.name)))
                  .limit(1);
                const existing = named[0];
                if (existing !== undefined && existing.driver !== input.driver) {
                  return { kind: 'name-conflict', name: input.name };
                }

                if (existing === undefined) {
                  await unmarkReplacedDefault();
                  const inserted = await tx
                    .insert(runtimeProfiles)
                    .values({ ...insertValues(checked.workspaceId, input), workspaceDefault: true })
                    .returning(RUNTIME_PROFILE_COLUMNS);
                  const row = inserted[0];
                  if (row === undefined) throw new Error('the insert returned no row');
                  await takeOverReplacedDefault(row.id);
                  await attachDefaultToUnprofiledAgents(tx, checked.workspaceId, row.id);
                  return { kind: 'created', profile: toRecord(row) };
                }

                if (!options.adoptable(toRecord(existing))) {
                  return { kind: 'not-adoptable', profile: toRecord(existing) };
                }

                await unmarkReplacedDefault();
                const marked = await tx
                  .update(runtimeProfiles)
                  .set({ workspaceDefault: true })
                  .where(within(eq(runtimeProfiles.id, existing.id)))
                  .returning(RUNTIME_PROFILE_COLUMNS);
                const row = marked[0];
                if (row === undefined) throw new Error('the update returned no row');
                await takeOverReplacedDefault(row.id);
                await attachDefaultToUnprofiledAgents(tx, checked.workspaceId, row.id);
                return { kind: 'adopted', profile: toRecord(row) };
              },
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
    },
  };
}
