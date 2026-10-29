/**
 * The sessions domain's persistence port and its PostgreSQL adapters — the one module of
 * `apps/web/server/sessions` that names `@agent-workspace/core/db` (F-08, W3-5). The routes, the
 * environment seam and the in-memory fakes depend on the types declared here; the composition root
 * wires the adapters below onto the tenant-scoped repositories. Copies the shape of
 * `apps/web/server/agents/store.ts` and `apps/web/server/connectors/store.ts`: a store is obtained
 * *for a workspace id*, so no route holds a scope or a repository provider.
 */
import { createHash } from 'node:crypto';

import {
  SESSION_STATE_PAGE_LIMIT,
  type KeysetPosition,
  type SessionRecord,
  type SessionRepository,
  type SessionRepositoryProvider,
  type SessionStateRepository,
  type SessionStateRepositoryProvider,
  type SessionTranscriptRepository,
  type StoredSessionStateBlob,
  type SessionTranscriptRepositoryProvider,
  type SessionVisibility,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';
import { bytesToStream, readBytes } from '@agent-workspace/core/storage/streams';
import type { ObjectStoreProvider } from '@agent-workspace/core/storage';

import type { StorageService } from '../storage/service';
import {
  type SessionStateBlobContent,
  type SessionStateBlobRef,
  type SessionStateBlobsUnavailable,
  type SessionStateEntryPayload,
  type SessionStateEntryRecord,
  type SessionStateStore,
  type SessionStateStreamRecord,
  type SessionStateStreamRef,
} from './state';
import type {
  TranscriptEntry,
  TranscriptKey,
  TranscriptSessionListing,
  TranscriptStore,
} from './transcript';

/** The control-plane session row the routes render, and the list query's inputs. */
export type { KeysetPosition, SessionRecord, SessionVisibility };

/** The largest page of session-state entries any store returns, whatever limit is asked for. */
export { SESSION_STATE_PAGE_LIMIT };

/** The session-row operations the §20 routes perform inside one workspace. */
type WorkspaceSessionsStore = Pick<
  SessionRepository,
  'get' | 'getByEngineSessionId' | 'list' | 'update' | 'archive' | 'restore'
>;

/**
 * The port: one workspace's session rows, or `null` when no workspace has that id — the route
 * then answers as it does for a workspace that no longer exists.
 */
export interface SessionsStoreProvider {
  forWorkspaceId(workspaceId: string): Promise<WorkspaceSessionsStore | null>;
}

/** The adapter onto the tenant-scoped PostgreSQL session repository. */
export function createRepositorySessionsStoreProvider(deps: {
  readonly repositories: SessionRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}): SessionsStoreProvider {
  return {
    async forWorkspaceId(workspaceId) {
      const scope = await deps.scopes.forWorkspaceId(workspaceId);
      return scope === null ? null : deps.repositories.forScope(scope);
    },
  };
}

/** Adapter from the web session mirror port to the tenant-scoped PostgreSQL repository. */
export class DatabaseTranscriptStore implements TranscriptStore {
  public constructor(
    private readonly repositories: SessionTranscriptRepositoryProvider,
    private readonly scopes: WorkspaceScopeResolver,
  ) {}

  async #repository(projectKey: string): Promise<SessionTranscriptRepository | null> {
    const scope = await this.scopes.forWorkspaceId(projectKey);
    return scope === null ? null : this.repositories.forScope(scope);
  }

  async append(key: TranscriptKey, entries: readonly TranscriptEntry[]): Promise<void> {
    const repository = await this.#repository(key.projectKey);
    if (repository === null) throw new Error(`no workspace has projectKey ${key.projectKey}`);
    await repository.append(key, entries);
  }

  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    const repository = await this.#repository(key.projectKey);
    if (repository === null) return null;
    const entries = await repository.load(key);
    return entries === null ? null : (entries as TranscriptEntry[]);
  }

  async listSessions(projectKey: string): Promise<TranscriptSessionListing[]> {
    const repository = await this.#repository(projectKey);
    if (repository === null) return [];
    return [...(await repository.listSessions(projectKey))];
  }

  async delete(key: TranscriptKey): Promise<void> {
    const repository = await this.#repository(key.projectKey);
    if (repository !== null) await repository.delete(key);
  }

  async listSubkeys(key: {
    readonly projectKey: string;
    readonly sessionId: string;
  }): Promise<string[]> {
    const repository = await this.#repository(key.projectKey);
    if (repository === null) return [];
    return [...(await repository.listSubkeys(key))];
  }

  /** Retention-only operation; transcript deletion remains distinct from session archival. */
  async purgeBefore(projectKey: string, before: Date): Promise<number> {
    const repository = await this.#repository(projectKey);
    return repository === null ? 0 : repository.purgeBefore(before);
  }
}

/**
 * The {@link SessionStateStore} the control plane actually runs: PostgreSQL for streams and
 * entries, the object store for blobs (ENG-06, #305).
 *
 * The shape is {@link DatabaseTranscriptStore}'s — an adapter from the port the routes are written against to
 * the tenant-scoped repository, resolving a {@link WorkspaceScope} from the tenant field every
 * reference carries — with one thing that class does not have: a second backend. Entries are rows; a
 * blob is bytes, and a `bytea` column holding a 32 MiB agent state directory would make every read
 * of the blob table expensive and every backup larger for no benefit. So the bytes go to
 * `packages/core/src/storage`'s `ObjectStore` and the row records where they went, how many there
 * were and what they hashed to. The bytes are saved through the one storage service, under a new
 * object ID in the `session-state` area (the storage design, §04).
 *
 * ## Bytes first, then the row
 *
 * `putBlob` writes the object and only then records it. The two orders fail differently and only one
 * of them fails safely: a row written before its bytes is a store that says a snapshot exists and
 * cannot produce it, while an object written before its row is an orphan the cleanup job reclaims
 * and nothing ever reads. The second is the one this code can survive.
 *
 * ## The digest is verified on the way out
 *
 * `getBlob` re-hashes what the object store returned and refuses a mismatch. A recorded digest that
 * is only ever *reported* proves nothing about the bytes a caller was handed — it is the check, not
 * the column, that makes the claim. The cost is bounded by the same cap the write is (32 MiB), and
 * a blob is read once per resume.
 */
/**
 * What {@link DatabaseSessionStateStore} needs. Without `storage` this deployment saves no blob;
 * absent is reported, never substituted (ADR-0035).
 */
export interface SessionStateStoreDeps {
  readonly repositories: SessionStateRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
  /** The one storage service: new blobs are saved through it, and rows are opened and deleted by it. */
  readonly storage?: Pick<StorageService, 'saveSessionState' | 'open' | 'deleteObject'> | undefined;
  /** storage-bridge(#1699): the old per-area store, read and purged for rows with no object id; never written. */
  readonly blobs?: ObjectStoreProvider | undefined;
}

const BLOBS_NOT_CONFIGURED: SessionStateBlobsUnavailable = {
  ok: false,
  reason:
    'this deployment has no object storage for session-state blobs, so an engine whose state is a ' +
    'file snapshot cannot be made durable here: either AW_STORAGE_URL is not set, or the storage ' +
    'service failed to open (see the start-up log). Fix the cause and restart. Stream entries ' +
    'are unaffected — they are database rows.',
};

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class DatabaseSessionStateStore implements SessionStateStore {
  public constructor(private readonly deps: SessionStateStoreDeps) {}

  /**
   * The repository for one tenant, or a thrown error.
   *
   * A workspace that cannot be resolved here is not "no state": the caller has already been
   * authenticated into that workspace and authorised against a session row inside it, so a
   * workspace that has disappeared between those lookups and this one is an infrastructure failure
   * and belongs in the 5xx that says so (ADR-0015 — an answer that cannot be computed is not an
   * empty one).
   */
  async #repository(workspaceId: string): Promise<SessionStateRepository> {
    const scope = await this.deps.scopes.forWorkspaceId(workspaceId);
    if (scope === null) {
      throw new Error(
        `the session-state store cannot resolve workspace ${workspaceId}, which was resolvable ` +
          `when this request was authenticated.`,
      );
    }
    return this.deps.repositories.forScope(scope);
  }

  async append(
    ref: SessionStateStreamRef,
    entries: readonly SessionStateEntryPayload[],
  ): Promise<void> {
    await (await this.#repository(ref.workspaceId)).append(ref, entries);
  }

  async list(
    ref: SessionStateStreamRef,
    page: { readonly afterSequence?: number | undefined; readonly limit?: number | undefined },
  ): Promise<readonly SessionStateEntryRecord[] | null> {
    return (await this.#repository(ref.workspaceId)).list(ref, page);
  }

  async deleteLast(ref: SessionStateStreamRef): Promise<number> {
    return (await this.#repository(ref.workspaceId)).deleteLast(ref);
  }

  async replaceAll(
    ref: SessionStateStreamRef,
    entries: readonly SessionStateEntryPayload[],
  ): Promise<void> {
    await (await this.#repository(ref.workspaceId)).replaceAll(ref, entries);
  }

  async deleteStream(ref: SessionStateStreamRef): Promise<void> {
    await (await this.#repository(ref.workspaceId)).deleteStream(ref);
  }

  async listStreams(tenant: {
    readonly workspaceId: string;
    readonly sessionId: string;
  }): Promise<readonly SessionStateStreamRecord[]> {
    return (await this.#repository(tenant.workspaceId)).listStreams(tenant.sessionId);
  }

  async putBlob(
    ref: SessionStateBlobRef,
    bytes: Uint8Array,
  ): Promise<{ readonly ok: true } | SessionStateBlobsUnavailable> {
    const { storage } = this.deps;
    // Without the storage service a blob would be saved with no object id; the old area store is
    // only read from now on.
    if (storage === undefined) return BLOBS_NOT_CONFIGURED;
    if (bytes.byteLength > SESSION_STATE_BLOB_MAX_BYTES) {
      // The route refuses an over-cap body while reading it, so reaching this line means a caller
      // inside the process bypassed that check. A throw, because it is a programming fault and not
      // a request this store should quietly store anyway.
      throw new Error(
        `a session-state blob of ${String(bytes.byteLength)} bytes exceeds the cap of ${String(SESSION_STATE_BLOB_MAX_BYTES)}.`,
      );
    }
    const saved = await storage.saveSessionState(ref, ref, bytesToStream(bytes));
    // The route refuses an over-cap body first; reaching this is the same programming fault.
    if (!saved.ok)
      throw new Error('a session-state blob was refused as too large after the cap check.');
    return { ok: true };
  }

  /**
   * Retention (`./retention.ts`): every stream, entry and blob of one workspace last written before
   * `before`. The rows go first and the bytes second — the order `putBlob`'s header argues for, in
   * reverse: an object left behind by a failed delete is an orphan nothing reads, while a row left
   * behind would be a snapshot the store claims and cannot produce.
   */
  async purgeBefore(
    workspaceId: string,
    before: Date,
  ): Promise<{
    readonly entries: number;
    readonly blobs: number;
    readonly sessionIds: readonly string[];
  }> {
    const scope = await this.deps.scopes.forWorkspaceId(workspaceId);
    if (scope === null) return { entries: 0, blobs: 0, sessionIds: [] };
    const purged = await this.deps.repositories.forScope(scope).purgeBefore(before);
    const { storage, blobs } = this.deps;
    for (const blob of purged.blobs) {
      const row = { area: 'session-state' as const, ...blob };
      if (storage !== undefined) await storage.deleteObject({ workspaceId }, row);
      else await blobs?.forWorkspace(workspaceId).delete(blob.storageKey);
    }
    return { entries: purged.entries, blobs: purged.blobs.length, sessionIds: purged.sessionIds };
  }

  async getBlob(
    ref: SessionStateBlobRef,
  ): Promise<
    | { readonly ok: true; readonly content: SessionStateBlobContent | null }
    | SessionStateBlobsUnavailable
  > {
    const { storage, blobs } = this.deps;
    if (storage === undefined && blobs === undefined) return BLOBS_NOT_CONFIGURED;
    const repository = await this.#repository(ref.workspaceId);
    let record = await repository.getBlob(ref.sessionId, ref.engine, ref.blobKey);
    if (record === null) return { ok: true, content: null };
    const read = async (row: StoredSessionStateBlob) => {
      // storage-bridge(#1699): a row with no object id is read at its old key from the old store
      const stream =
        storage !== undefined
          ? await storage.open(ref, { area: 'session-state', ...row })
          : row.objectId === null
            ? await blobs?.forWorkspace(ref.workspaceId).read(row.storageKey)
            : null;
      return stream === null || stream === undefined
        ? null
        : readBytes(stream.body, SESSION_STATE_BLOB_MAX_BYTES);
    };
    let bytes = await read(record);
    if (bytes === null && record.objectId !== null) {
      // A save that confirmed between the read of the row and the open deletes the object this row
      // named; the row it confirmed names the new one.
      const current = await repository.getBlob(ref.sessionId, ref.engine, ref.blobKey);
      if (current === null) return { ok: true, content: null };
      if (current.objectId !== record.objectId) {
        record = current;
        bytes = await read(record);
      }
    }
    if (bytes === null) {
      throw new Error(
        `session-state blob ${ref.blobKey} is recorded for session ${ref.sessionId} but its bytes ` +
          `are not in the object store. The row and the object have diverged; this is not an ` +
          `empty blob.`,
      );
    }
    const observed = sha256Of(bytes);
    if (observed !== record.sha256) {
      throw new Error(
        `session-state blob ${ref.blobKey} of session ${ref.sessionId} hashes to ${observed} and ` +
          `the store recorded ${record.sha256}. Refusing to replay a snapshot that is not the one ` +
          `written.`,
      );
    }
    return { ok: true, content: { bytes, sha256: record.sha256 } };
  }
}
