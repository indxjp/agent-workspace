import { normalizeArchivePath, RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { type AgentResourceAssignmentsInput } from '@indx-workspace/contracts/agents';
import {
  isUnderAllowedPrefix,
  storageGrantListingUnavailable,
  storageGrantUnavailable,
} from '../agent-versions/storage-grants';
import { DomainError } from '../errors';
import { STREAMED_SHA256 } from '../runs/streamed-digests';
import { log } from '../telemetry/logger';
import {
  type RunFileGrant,
  type RunFileSource,
  type AgentRunResourceLoaderDependencies,
  type RunConnectionStore,
  type DeliveredStorageFolder,
} from './resource-loader-contract';
import { runFilesTooLarge } from './resource-loader-files';

/**
 * A key is deliverable only if it is already the path it would be archived as: `normalizeArchivePath`
 * decodes and folds, so any key it changes (`..`, `%2e%2e`, `\\`, an absolute path, a trailing `/`) is skipped.
 */
function isArchivableKey(key: string): boolean {
  try {
    return normalizeArchivePath(key) === key;
  } catch {
    return false;
  }
}

/** One page of a granted folder; a provider failure is the run's typed refusal. */
async function listGrantedFolder(
  store: RunConnectionStore,
  prefix: string,
  options: { readonly recursive: true; readonly cursor?: string },
  connectionName: string,
): ReturnType<RunConnectionStore['listPage']> {
  try {
    return await store.listPage(prefix, options);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw storageGrantListingUnavailable(connectionName, error);
  }
}

/**
 * Each granted connection folder as references under `storage/<name>/` (the storage design, §05).
 * The grant is judged against the connection as it is now, not as it was deployed: a connection that
 * is gone or no longer allows the folder refuses the run. The folder is delivered writable only to a
 * `read-write` grant of a connection that allows writes, and `storage-writeback.ts` saves the run's
 * changes. It is listed page by page; the bytes are streamed later through `sources`.
 */
// @story US-STO-12

interface StorageGrantState {
  readonly byPath: Map<string, RunFileGrant>;
  readonly sources: Map<string, RunFileSource>;
  total: number;
}
interface StorageFolder {
  readonly root: string;
  readonly prefix: string;
  readonly access: 'read' | 'read-write';
  readonly sizesOnly: boolean;
  readonly store: RunConnectionStore;
}
function addStorageReference(byPath: Map<string, RunFileGrant>, grant: RunFileGrant): void {
  const held = byPath.get(grant.path);
  byPath.set(grant.path, held?.access === 'read' ? held : grant);
}
function appendStorageEntry(
  entry: Awaited<ReturnType<RunConnectionStore['listPage']>>['entries'][number],
  folder: StorageFolder,
  state: StorageGrantState,
): number {
  const { root, prefix, access, sizesOnly, store } = folder;

  if (entry.kind !== 'file') return 0;
  const { key } = entry;
  const path = `${root}/${key}`;
  if (!key.startsWith(`${prefix}/`) || !isArchivableKey(key) || !isArchivableKey(path)) {
    return 1;
  }
  // Overlapping grants list the same object twice; it is delivered, and counted, once.
  if (!state.byPath.has(path)) state.total += entry.sizeBytes;
  if (state.total > RUN_FILES_MAX_BYTES) throw runFilesTooLarge(state.total);
  addStorageReference(state.byPath, {
    kind: 'file',
    path,
    access,
    size: entry.sizeBytes,
    sha256: sizesOnly ? '' : STREAMED_SHA256,
  });
  if (!sizesOnly) {
    state.sources.set(path, {
      objectId: null,
      streamed: true,
      open: async () => (await store.read(key))?.body ?? null,
    });
  }

  return 0;
}

async function loadStorageGrants(context: {
  readonly workspaceId: string;
  readonly grants: NonNullable<AgentResourceAssignmentsInput['storageGrants']>;
  readonly dependencies: AgentRunResourceLoaderDependencies;
  readonly sources: Map<string, RunFileSource>;
  readonly mayWrite: boolean;
  readonly folders: Map<string, DeliveredStorageFolder>;
}): Promise<readonly RunFileGrant[]> {
  const { workspaceId, grants, dependencies, sources, mayWrite, folders } = context;

  if (grants.length === 0) return [];
  const { storageConnections } = dependencies;
  if (storageConnections === undefined) {
    throw storageGrantUnavailable('this deployment keeps no storage connections');
  }
  const sizesOnly = dependencies.sizesOnly === true;
  const byPath = new Map<string, RunFileGrant>();
  const state: StorageGrantState = { byPath, sources, total: 0 };
  for (const grant of grants) {
    const connection = await storageConnections.get(workspaceId, grant.connectionId);
    if (connection === null) {
      throw storageGrantUnavailable('a granted storage connection no longer exists');
    }
    if (
      !connection.allowedPrefixes.some((allowed) => isUnderAllowedPrefix(grant.prefix, allowed))
    ) {
      throw storageGrantUnavailable(
        `the folder ${JSON.stringify(grant.prefix)} is no longer one the connection ${JSON.stringify(connection.name)} allows`,
      );
    }
    // Writable only when the grant, the agent's `writeFiles` and the connection all allow it.
    const access =
      grant.access === 'read-write' && mayWrite && connection.writeAllowed ? 'read-write' : 'read';
    const root = `storage/${connection.name}`;
    const store = await storageConnections.open(workspaceId, grant.connectionId);
    addStorageReference(byPath, { kind: 'directory', path: `${root}/${grant.prefix}`, access });
    if (access === 'read-write') {
      folders.set(`${root}/${grant.prefix}`, {
        connectionId: grant.connectionId,
        prefix: grant.prefix,
      });
    }
    let skipped = 0;
    let cursor: string | undefined;
    do {
      const page = await listGrantedFolder(
        store,
        grant.prefix,
        cursor === undefined ? { recursive: true } : { recursive: true, cursor },
        connection.name,
      );
      for (const entry of page.entries)
        skipped += appendStorageEntry(
          entry,
          { root, prefix: grant.prefix, access, sizesOnly, store },
          state,
        );
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    if (skipped > 0) {
      log.warn('[runs] storage objects with unsafe keys were not delivered', {
        connectionId: grant.connectionId,
        skipped,
      });
    }
  }
  return [...byPath.values()];
}
export { loadStorageGrants };
