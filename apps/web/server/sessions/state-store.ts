/**
 * The {@link SessionStateStore} the control plane actually runs: PostgreSQL for streams and
 * entries, the object store for blobs (ENG-06, #305).
 *
 * The shape is `./database-store.ts`'s — an adapter from the port the routes are written against to
 * the tenant-scoped repository, resolving a {@link WorkspaceScope} from the tenant field every
 * reference carries — with one thing that file does not have: a second backend. Entries are rows; a
 * blob is bytes, and a `bytea` column holding a 32 MiB agent state directory would make every read
 * of the blob table expensive and every backup larger for no benefit. So the bytes go to
 * `packages/core/src/storage`'s `ObjectStore` and the row records where they went, how many there
 * were and what they hashed to.
 *
 * ## Bytes first, then the row
 *
 * `putBlob` writes the object and only then records it. The two orders fail differently and only one
 * of them fails safely: a row written before its bytes is a store that says a snapshot exists and
 * cannot produce it, while an object written before its row is an orphan the next write overwrites
 * and nothing ever reads. The second is the one this code can survive.
 *
 * ## The digest is verified on the way out
 *
 * `getBlob` re-hashes what the object store returned and refuses a mismatch. A recorded digest that
 * is only ever *reported* proves nothing about the bytes a caller was handed — it is the check, not
 * the column, that makes the claim. The cost is bounded by the same cap the write is (32 MiB), and
 * a blob is read once per resume.
 */
import { createHash } from 'node:crypto';

import type {
  SessionStateRepository,
  SessionStateRepositoryProvider,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';

import type { ObjectStoreProvider } from '../files/object-store-bridge';
import {
  sessionStateBlobStorageKey,
  type SessionStateBlobContent,
  type SessionStateBlobRef,
  type SessionStateBlobsUnavailable,
  type SessionStateEntryPayload,
  type SessionStateEntryRecord,
  type SessionStateStore,
  type SessionStateStreamRecord,
  type SessionStateStreamRef,
} from './state';

/** What {@link DatabaseSessionStateStore} needs. `blobs` absent means this deployment stores none. */
export interface SessionStateStoreDeps {
  readonly repositories: SessionStateRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
  /** The object store the bytes live in. Absent is reported, never substituted (ADR-0035). */
  readonly blobs?: ObjectStoreProvider | undefined;
}

const BLOBS_NOT_CONFIGURED: SessionStateBlobsUnavailable = {
  ok: false,
  reason:
    'this deployment has no object storage for session-state blobs, so an engine whose state is a ' +
    'file snapshot cannot be made durable here. Set AW_SESSION_TRANSCRIPT_ROOT, or configure ' +
    'OBJECT_STORAGE_BUCKET, and restart. Stream entries are unaffected — they are database rows.',
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
    const provider = this.deps.blobs;
    if (provider === undefined) return BLOBS_NOT_CONFIGURED;
    if (bytes.byteLength > SESSION_STATE_BLOB_MAX_BYTES) {
      // The route refuses an over-cap body while reading it, so reaching this line means a caller
      // inside the process bypassed that check. A throw, because it is a programming fault and not
      // a request this store should quietly store anyway.
      throw new Error(
        `a session-state blob of ${String(bytes.byteLength)} bytes exceeds the cap of ${String(SESSION_STATE_BLOB_MAX_BYTES)}.`,
      );
    }
    const repository = await this.#repository(ref.workspaceId);
    const storageKey = sessionStateBlobStorageKey(ref);
    await provider
      .forWorkspace(ref.workspaceId)
      .put(storageKey, { body: bytes, contentType: 'application/octet-stream' });
    await repository.putBlob(ref.sessionId, {
      engine: ref.engine,
      blobKey: ref.blobKey,
      storageKey,
      sizeBytes: bytes.byteLength,
      sha256: sha256Of(bytes),
    });
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
  ): Promise<{ readonly entries: number; readonly blobs: number }> {
    const scope = await this.deps.scopes.forWorkspaceId(workspaceId);
    if (scope === null) return { entries: 0, blobs: 0 };
    const purged = await this.deps.repositories.forScope(scope).purgeBefore(before);
    const objects = this.deps.blobs?.forWorkspace(workspaceId);
    if (objects !== undefined) {
      for (const blob of purged.blobs) await objects.delete(blob.storageKey);
    }
    return { entries: purged.entries, blobs: purged.blobs.length };
  }

  async getBlob(
    ref: SessionStateBlobRef,
  ): Promise<
    | { readonly ok: true; readonly content: SessionStateBlobContent | null }
    | SessionStateBlobsUnavailable
  > {
    const provider = this.deps.blobs;
    if (provider === undefined) return BLOBS_NOT_CONFIGURED;
    const repository = await this.#repository(ref.workspaceId);
    const record = await repository.getBlob(ref.sessionId, ref.engine, ref.blobKey);
    if (record === null) return { ok: true, content: null };
    const object = await provider.forWorkspace(ref.workspaceId).get(record.storageKey);
    if (object === null) {
      throw new Error(
        `session-state blob ${ref.blobKey} is recorded for session ${ref.sessionId} but its bytes ` +
          `are not in the object store. The row and the object have diverged; this is not an ` +
          `empty blob.`,
      );
    }
    const observed = sha256Of(object.body);
    if (observed !== record.sha256) {
      throw new Error(
        `session-state blob ${ref.blobKey} of session ${ref.sessionId} hashes to ${observed} and ` +
          `the store recorded ${record.sha256}. Refusing to replay a snapshot that is not the one ` +
          `written.`,
      );
    }
    return { ok: true, content: { bytes: object.body, sha256: record.sha256 } };
  }
}
