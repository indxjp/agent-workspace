/**
 * The port `/api/runtime-profiles` talks to, and the PostgreSQL adapter onto
 * `packages/core/src/db/repositories/runtime-profiles.ts`.
 *
 * Copies `apps/web/server/agents/store.ts`'s shape exactly — read that file's header first for why
 * a store is obtained *for a workspace id* (never a `WorkspaceScope`, which is a sibling package's
 * type). The reasoning is unchanged; only the resource differs.
 */
import {
  UnknownWorkspaceError,
  type CreateRuntimeProfileInput as CoreCreateRuntimeProfileInput,
  type RuntimeProfileRecord as CoreRuntimeProfileRecord,
  type RuntimeProfileRepository as CoreRuntimeProfileRepository,
  type RuntimeProfileRepositoryProvider as CoreRuntimeProfileRepositoryProvider,
  type UpdateRuntimeProfilePatch as CoreUpdateRuntimeProfilePatch,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
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
