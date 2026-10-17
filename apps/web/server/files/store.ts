/**
 * The port the files routes talk to: an {@link ObjectStore} keyed by a raw `workspaceId: string`,
 * the same shape `apps/web/server/agents/store.ts` uses for
 * {@link import('./runtime.js').FilesRuntime} to hand a route handler exactly what it needs.
 *
 * `packages/core/src/storage`'s own {@link ObjectStore} already has no method that takes a
 * workspace id — scoping happens once, at `ObjectStoreProvider.forWorkspace(workspaceId)`, a plain
 * string (see `object-store.ts`'s header for why it is not the repository layer's `WorkspaceScope`
 * class) — so this module does not need a second copy of that interface. What it adds is the
 * positive-assertion lookup `agents/store.ts` also makes, for the same reason: spec §25 wants a
 * store handed back because a `workspaces` row was found, never because the id merely looked
 * plausible (ADR-0015). The resolved `WorkspaceScope` itself is discarded immediately after that
 * check — only its existence mattered here, not its identity — which is what keeps this module
 * free of the cross-module class-identity hazard `object-store.ts`'s header documents.
 */
import {
  UnknownWorkspaceError,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import type { ObjectStore, ObjectStoreProvider } from './object-store-bridge';

/** Hands out an {@link ObjectStore} for one workspace, named by its id. */
export interface WorkspaceObjectStoreProvider {
  forWorkspace(workspaceId: string): ObjectStore;
}

/** What {@link createRepositoryObjectStoreProvider} needs, and the whole of it. */
export interface RepositoryObjectStoreDependencies {
  /** The scoped object-store provider — local filesystem today; see `object-store-bridge.ts`. */
  readonly store: ObjectStoreProvider;
  /** Turns a workspace id into a `WorkspaceScope`, or answers `null`. */
  readonly scopes: CoreWorkspaceScopeResolver;
}

/**
 * The real {@link WorkspaceObjectStoreProvider}. The lookup is memoised per `forWorkspace` call —
 * not per method call — for the same reason `agents/store.ts` memoises its own: a request that
 * lists and then reads pays for one scope resolution, not two, and two calls in one request
 * cannot end up scoped to two different answers.
 */
export function createRepositoryObjectStoreProvider(
  dependencies: RepositoryObjectStoreDependencies,
): WorkspaceObjectStoreProvider {
  return {
    forWorkspace(workspaceId: string): ObjectStore {
      let pending: Promise<ObjectStore> | null = null;
      const resolved = (): Promise<ObjectStore> => {
        pending ??= (async (): Promise<ObjectStore> => {
          const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new UnknownWorkspaceError(workspaceId);
          return dependencies.store.forWorkspace(workspaceId);
        })();
        return pending;
      };

      return {
        put: async (key, input) => (await resolved()).put(key, input),
        get: async (key) => (await resolved()).get(key),
        delete: async (key) => (await resolved()).delete(key),
        list: async (prefix) => (await resolved()).list(prefix),
        listPrefix: async (prefix) => (await resolved()).listPrefix(prefix),
        copyObject: async (source, destination) =>
          (await resolved()).copyObject(source, destination),
      };
    },
  };
}
