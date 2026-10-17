/**
 * The port the skills routes talk to: an {@link ObjectStore} keyed by a raw `workspaceId: string`,
 * the same shape `apps/web/server/files/store.ts` uses for
 * {@link import('./runtime.js').SkillsRuntime} to hand a route handler exactly what it needs.
 *
 * `packages/core/src/storage`'s own {@link ObjectStore} already has no method that takes a
 * workspace id — scoping happens once, at `ObjectStoreProvider.forWorkspace(workspaceId)`, a plain
 * string (see `@agent-workspace/core/storage`'s `object-store.ts` header for why it is not the
 * repository layer's `WorkspaceScope` class) — so this module does not need a second copy of that
 * interface. What it adds is the positive-assertion lookup `files/store.ts` also makes, for the
 * same reason: spec §25 wants a store handed back because a `workspaces` row was found, never
 * because the id merely looked plausible (ADR-0015). The resolved `WorkspaceScope` itself is
 * discarded immediately after that check — only its existence mattered here, not its identity.
 */
import {
  UnknownWorkspaceError,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import type { ObjectStore, ObjectStoreProvider } from './object-store-bridge';

/** Hands out an {@link ObjectStore} for one workspace's skills, named by the workspace's id. */
export interface WorkspaceSkillsStoreProvider {
  forWorkspace(workspaceId: string): ObjectStore;
}

/** What {@link createRepositorySkillsStoreProvider} needs, and the whole of it. */
export interface RepositorySkillsStoreDependencies {
  /** The scoped object-store provider — local filesystem today; see `object-store-bridge.ts`. */
  readonly store: ObjectStoreProvider;
  /** Turns a workspace id into a `WorkspaceScope`, or answers `null`. */
  readonly scopes: CoreWorkspaceScopeResolver;
}

/**
 * The real {@link WorkspaceSkillsStoreProvider}. The lookup is memoised per `forWorkspace` call —
 * not per method call — for the same reason `files/store.ts` memoises its own: a request that
 * lists and then reads pays for one scope resolution, not two.
 */
export function createRepositorySkillsStoreProvider(
  dependencies: RepositorySkillsStoreDependencies,
): WorkspaceSkillsStoreProvider {
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
        // W9-FILES-131 added `listPrefix`/`copyObject` to the shared `ObjectStore` contract
        // (`packages/core/src/storage/object-store.ts`) for its subtree move/delete; this
        // wrapper forwards them mechanically, the same way it already forwards every other
        // method, so it keeps satisfying that interface. See this task's PR for why a file
        // outside its declared `Owns` globs needed this two-line, non-semantic change.
        listPrefix: async (prefix) => (await resolved()).listPrefix(prefix),
        copyObject: async (source, destination) =>
          (await resolved()).copyObject(source, destination),
      };
    },
  };
}
