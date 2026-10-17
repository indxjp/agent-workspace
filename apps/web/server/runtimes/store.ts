/**
 * The port `/api/runtime-profiles` talks to, and the PostgreSQL adapter onto
 * `packages/core/src/db/repositories/runtime-profiles.ts`.
 *
 * Copies `apps/web/server/agents/store.ts`'s shape exactly — read that file's header first for why
 * a store is obtained *for a workspace id* (never a `WorkspaceScope`, which is a sibling package's
 * type) and why every core reference here is a type. The reasoning is unchanged; only the resource
 * differs.
 */
import type {
  CreateRuntimeProfileInput as CoreCreateRuntimeProfileInput,
  RuntimeProfileRecord as CoreRuntimeProfileRecord,
  RuntimeProfileRepository as CoreRuntimeProfileRepository,
  RuntimeProfileRepositoryProvider as CoreRuntimeProfileRepositoryProvider,
  UpdateRuntimeProfilePatch as CoreUpdateRuntimeProfilePatch,
  WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

/** One `runtime_profiles` row, as this layer hands it around. Mirrors the repository's record. */
export interface RuntimeProfileRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly driver: string;
  readonly runtimeConnectionId: string | null;
  readonly cpu: number | null;
  readonly memoryMb: number | null;
  readonly diskMb: number | null;
  readonly networkPolicy: string;
  readonly allowedDomains: readonly string[] | null;
  readonly filesystem: string;
  readonly persistPaths: readonly string[] | null;
  readonly timeoutSeconds: number | null;
  readonly idleTimeoutSeconds: number | null;
  readonly driverConfig: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CreateRuntimeProfileInput = CoreCreateRuntimeProfileInput;
export type UpdateRuntimeProfilePatch = CoreUpdateRuntimeProfilePatch;

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

/** Runtime-profile persistence for exactly one workspace. No method takes a workspace id. */
export interface WorkspaceRuntimeProfileStore {
  list(): Promise<readonly RuntimeProfileRecord[]>;
  get(id: string): Promise<RuntimeProfileRecord | null>;
  create(input: CreateRuntimeProfileInput): Promise<CreateRuntimeProfileOutcome>;
  update(id: string, patch: UpdateRuntimeProfilePatch): Promise<UpdateRuntimeProfileOutcome>;
  delete(id: string): Promise<DeleteRuntimeProfileOutcome>;
}

/** Hands out a {@link WorkspaceRuntimeProfileStore} bound to one workspace. */
export interface RuntimeProfileStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceRuntimeProfileStore;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The PostgreSQL implementation, as an adapter onto the repository layer.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a store is asked for a workspace no `workspaces` row names. Declared here, not
 * imported, for the mechanical reason `agents/store.ts`'s identical class gives: every reference
 * to core in this file is a type, and a value import would drag `pg` into the edge bundle
 * `apps/web/instrumentation.ts` also compiles for.
 */
export class UnknownWorkspaceError extends Error {
  public readonly workspaceId: string;

  public constructor(workspaceId: string) {
    super(
      `no workspace has id ${workspaceId}; a runtime-profile store cannot be scoped to a ` +
        'workspace that does not exist',
    );
    this.name = 'UnknownWorkspaceError';
    this.workspaceId = workspaceId;
  }
}

/** What {@link createRepositoryRuntimeProfileStoreProvider} needs, and the whole of it. */
export interface RepositoryRuntimeProfileStoreDependencies {
  readonly repositories: CoreRuntimeProfileRepositoryProvider;
  readonly scopes: CoreWorkspaceScopeResolver;
}

function toRecord(profile: CoreRuntimeProfileRecord): RuntimeProfileRecord {
  return profile;
}

/** The database-backed {@link RuntimeProfileStoreProvider}. See `agents/store.ts`'s equivalent. */
export function createRepositoryRuntimeProfileStoreProvider(
  dependencies: RepositoryRuntimeProfileStoreDependencies,
): RuntimeProfileStoreProvider {
  return {
    forWorkspace(workspaceId: string): WorkspaceRuntimeProfileStore {
      let pending: Promise<CoreRuntimeProfileRepository> | null = null;
      const repository = (): Promise<CoreRuntimeProfileRepository> => {
        pending ??= (async (): Promise<CoreRuntimeProfileRepository> => {
          const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new UnknownWorkspaceError(workspaceId);
          return dependencies.repositories.forScope(scope);
        })();
        return pending;
      };

      return {
        async list(): Promise<readonly RuntimeProfileRecord[]> {
          return (await repository()).list().then((rows) => rows.map(toRecord));
        },
        async get(id: string): Promise<RuntimeProfileRecord | null> {
          const row = await (await repository()).get(id);
          return row === null ? null : toRecord(row);
        },
        async create(input: CreateRuntimeProfileInput): Promise<CreateRuntimeProfileOutcome> {
          const outcome = await (await repository()).create(input);
          return outcome.kind === 'created'
            ? { kind: 'created', profile: toRecord(outcome.profile) }
            : outcome;
        },
        async update(
          id: string,
          patch: UpdateRuntimeProfilePatch,
        ): Promise<UpdateRuntimeProfileOutcome> {
          const outcome = await (await repository()).update(id, patch);
          return outcome.kind === 'updated'
            ? { kind: 'updated', profile: toRecord(outcome.profile) }
            : outcome;
        },
        async delete(id: string): Promise<DeleteRuntimeProfileOutcome> {
          return (await repository()).delete(id);
        },
      };
    },
  };
}
