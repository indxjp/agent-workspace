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
  CatalogPathPendingError,
  FILE_TEXT_MAX_CHARS,
  UnknownWorkspaceError,
  type FileTextRepository,
  type FileTextRepositoryProvider,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import type {
  ObjectStoreCapabilities,
  ObjectStore,
  ObjectStoreProvider,
} from '@agent-workspace/core/storage';

/** What an unusable workspace id reports: every operation on it rejects before reaching a store. */
const NO_CAPABILITIES: ObjectStoreCapabilities = {
  sign: false,
  boundLengthSign: false,
  range: false,
  conditionalPut: false,
  fileAndFolderShareKey: false,
};

/**
 * Whether a catalog write was refused because an upload to the path, or under the folder, is
 * still pending (FX-7). The files routes answer it `409 upload_in_progress`.
 */
export function isUploadInProgress(error: unknown): boolean {
  return error instanceof CatalogPathPendingError;
}

/** Hands out an {@link ObjectStore} for one workspace, named by its id. */
export interface WorkspaceObjectStoreProvider {
  forWorkspace(workspaceId: string): ObjectStore;
}

/** What {@link createRepositoryObjectStoreProvider} needs, and the whole of it. */
export interface RepositoryObjectStoreDependencies {
  /** The scoped object-store provider — local filesystem today; see `composition/storage.ts`. */
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

      // What the backend offers is a property of the provider, not of the workspace, so it can be
      // read before the scope lookup. An invalid id throws here and again, properly, in `resolved`.
      let signs: boolean;
      let capabilities: ObjectStoreCapabilities;
      try {
        const probe = dependencies.store.forWorkspace(workspaceId);
        signs = probe.createSignedUrl !== undefined;
        capabilities = probe.capabilities;
      } catch {
        signs = false;
        capabilities = NO_CAPABILITIES;
      }

      const scoped: ObjectStore = {
        capabilities,
        head: async (key) => (await resolved()).head(key),
        read: async (key, options) => (await resolved()).read(key, options),
        write: async (key, body, options) => (await resolved()).write(key, body, options),
        listPage: async (prefix, options) => (await resolved()).listPage(prefix, options),
        delete: async (key) => (await resolved()).delete(key),
        copy: async (source, destination) => (await resolved()).copy(source, destination),
      };
      if (!signs) return scoped;
      return {
        ...scoped,
        createSignedUrl: async (key, request) => {
          const store = await resolved();
          if (store.createSignedUrl === undefined) {
            throw new Error('The object store stopped offering signed URLs.');
          }
          return store.createSignedUrl(key, request);
        },
      };
    },
  };
}

/** The cache of extracted file text that search reads and refreshes (ADR-0147). */
export type FileTextStore = FileTextRepository;

export { FILE_TEXT_MAX_CHARS };

/** Hands out the {@link FileTextStore} of one workspace, named by its id. */
export interface FileTextStoreProvider {
  forWorkspace(workspaceId: string): Promise<FileTextStore>;
}

export function createFileTextStoreProvider(dependencies: {
  readonly repositories: FileTextRepositoryProvider;
  readonly scopes: CoreWorkspaceScopeResolver;
}): FileTextStoreProvider {
  return {
    async forWorkspace(workspaceId) {
      const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new UnknownWorkspaceError(workspaceId);
      return dependencies.repositories.forScope(scope);
    },
  };
}
