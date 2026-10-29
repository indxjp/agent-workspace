/**
 * The persistence seam of the storage service: the catalog port and its row type, the errors the
 * service must tell apart, and the catalog's rename rule for a legacy storage key. `service.ts` imports these from here, never from
 * `packages/core/src/db` (the `domain-does-not-import-persistence` rule), the way
 * `files/store.ts` does.
 *
 * It also holds the skills object provider (`SkillObjects`, `createRepositorySkillsStoreProvider`):
 * the storage design §07 rule 3 seam the skills domain uses instead of the core storage barrel.
 */
import {
  CatalogPathPendingError,
  CatalogPathTakenError,
  UnknownWorkspaceError,
  type ResourceCatalogRepository,
  type SessionStateRepository,
  type StorageMigrationRunRepository,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type {
  ObjectListEntry,
  ObjectStore,
  ObjectStoreProvider,
} from '@agent-workspace/core/storage';

export { renamedKey } from '@agent-workspace/core/db';

export type { CatalogFile, CatalogPort, CatalogSkill, LockOutcome } from '@agent-workspace/core/db';

/** The one catalog write the old-naming migration needs. */
export type LegacyAdopter = Pick<ResourceCatalogRepository, 'adoptLegacyFiles'>;

/** What the copy stage needs of the file catalog: the work list and the conditional switch. */
export type LegacyCopier = Pick<ResourceCatalogRepository, 'list' | 'switchObject'>;

/** What the copy stage needs of the session-state blob rows. */
export type LegacyBlobCopier = Pick<SessionStateRepository, 'listLegacyBlobs' | 'switchBlobObject'>;

/** A reserve met a pending upload of another owner (the storage design, §04). */
export function isPathPending(error: unknown): boolean {
  return error instanceof CatalogPathPendingError;
}

/** A rename met a path another row holds. */
export function isPathTaken(error: unknown): boolean {
  return error instanceof CatalogPathTakenError;
}

/** What the finalize stage needs of the file catalog (the whole repository: it also reads skills). */
export type FinalizeCatalog = ResourceCatalogRepository;

/** What the skills adopt stage needs of the catalog: it lists skills and fills their rows. */
export type SkillsAdoptCatalog = ResourceCatalogRepository;

/** What the finalize stage needs of the session-state blob rows. */
export type FinalizeBlobCatalog = Pick<
  SessionStateRepository,
  'countLegacyBlobs' | 'listObjectBlobs' | 'legacyBlobKeysHeld'
>;

/** The log of verify passes. */
export type MigrationRuns = StorageMigrationRunRepository;

/** A listed skill object. */
export type SkillObjectEntry = ObjectListEntry;

/**
 * What the skills domain may do with a workspace's skill objects (the storage design, §07 rule 3):
 * no signed links. Only the skill files that are not yet catalog rows go through it; `read` and
 * `listPage` let moving them into rows stream the bytes and page the listing.
 */
export type SkillObjects = Pick<
  ObjectStore,
  'delete' | 'copy' | 'head' | 'read' | 'write' | 'listPage'
>;

/** Hands out the {@link SkillObjects} of one workspace, named by the workspace's id. */
export interface WorkspaceSkillsStoreProvider {
  forWorkspace(workspaceId: string): SkillObjects;
}

/** What {@link createRepositorySkillsStoreProvider} needs, and the whole of it. */
export interface RepositorySkillsStoreDependencies {
  /** The scoped object-store provider — see `composition/storage.ts`. */
  readonly store: ObjectStoreProvider;
  /** Turns a workspace id into a `WorkspaceScope`, or answers `null`. */
  readonly scopes: WorkspaceScopeResolver;
}

/**
 * The real {@link WorkspaceSkillsStoreProvider}. A store is handed back because a `workspaces` row
 * was found, never because the id merely looked plausible (ADR-0015); only its existence matters.
 * The lookup is memoised per `forWorkspace` call, so a request that lists and then reads resolves
 * the scope once.
 */
export function createRepositorySkillsStoreProvider(
  dependencies: RepositorySkillsStoreDependencies,
): WorkspaceSkillsStoreProvider {
  return {
    forWorkspace(workspaceId: string): SkillObjects {
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
        delete: async (key) => (await resolved()).delete(key),
        copy: async (source, destination) => (await resolved()).copy(source, destination),
        head: async (key) => (await resolved()).head(key),
        read: async (key, options) => (await resolved()).read(key, options),
        write: async (key, body, options) => (await resolved()).write(key, body, options),
        listPage: async (prefix, options) => (await resolved()).listPage(prefix, options),
      };
    },
  };
}
