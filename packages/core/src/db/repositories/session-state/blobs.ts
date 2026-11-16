import { asc, eq, inArray, lt, or, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { sessionStateBlobs } from '../../schema/session-state-blobs.js';
import type { ScopedSessionState } from './scoped.js';
import {
  assertCallerBlobKey,
  blobSideKey,
  claimColumns,
  every,
  newSideKey,
  readableColumns,
  toClaim,
  unchanged,
} from './sql.js';
import type {
  SessionStateBlobClaim,
  SessionStateBlobConfirmation,
  SessionStateBlobRepository,
} from './types.js';

type BlobMethods = Omit<SessionStateBlobRepository, 'purgeBefore'>;

async function reserveBlob(
  db: Database,
  s: ScopedSessionState,
  sessionId: string,
  blob: Parameters<BlobMethods['reserveBlob']>[1],
): Promise<SessionStateBlobClaim> {
  const [row] = await db
    .insert(sessionStateBlobs)
    .values({
      workspaceId: s.workspaceId,
      sessionId,
      engine: blob.engine,
      blobKey: blobSideKey(blob.objectId),
      objectId: blob.objectId,
      storageKey: blob.storageKey,
      status: 'pending',
      // Measured on the way to the store and recorded by the confirm; no read serves a
      // pending row, so these placeholders are never handed out.
      sizeBytes: 0,
      sha256: '',
    })
    .returning(claimColumns);
  if (row === undefined) throw new Error('the session-state reservation was not written');
  return toClaim(row);
}

async function confirmBlob(
  db: Database,
  s: ScopedSessionState,
  pending: SessionStateBlobClaim,
  confirmation: SessionStateBlobConfirmation,
): ReturnType<BlobMethods['confirmBlob']> {
  assertCallerBlobKey(confirmation.blobKey);
  if (pending.status !== 'pending') return null;
  return db.transaction(async (tx) => {
    await s.lockBlobKey(tx, pending.sessionId, pending.engine, confirmation.blobKey);
    const held = await tx
      .select({ rowKey: sessionStateBlobs.blobKey })
      .from(sessionStateBlobs)
      .where(
        every(s.blobWhere(pending.sessionId, pending.engine, pending.rowKey), unchanged(pending)),
      )
      .for('update');
    if (held.length === 0) return null;
    const replaced = await tx
      .update(sessionStateBlobs)
      .set({ blobKey: newSideKey, status: 'deleting' })
      .where(s.blobWhere(pending.sessionId, pending.engine, confirmation.blobKey))
      .returning(claimColumns);
    await tx
      .update(sessionStateBlobs)
      .set({
        blobKey: confirmation.blobKey,
        status: 'ready',
        sizeBytes: confirmation.sizeBytes,
        sha256: confirmation.sha256,
      })
      .where(s.blobWhere(pending.sessionId, pending.engine, pending.rowKey));
    const [aside] = replaced;
    return { replaced: aside === undefined ? null : toClaim(aside) };
  });
}

/** The claim half of the blob methods: a save's settlement and the cleanup job's. */
function createBlobClaims(
  db: Database,
  s: ScopedSessionState,
): Pick<
  BlobMethods,
  'reserveBlob' | 'confirmBlob' | 'claimBlob' | 'forgetBlob' | 'unsettledBlobs'
> {
  return {
    reserveBlob: (sessionId, blob) => reserveBlob(db, s, sessionId, blob),
    confirmBlob: (pending, confirmation) => confirmBlob(db, s, pending, confirmation),

    async claimBlob(pending) {
      if (pending.status !== 'pending') return null;
      const [row] = await db
        .update(sessionStateBlobs)
        .set({ status: 'deleting' })
        .where(
          every(s.blobWhere(pending.sessionId, pending.engine, pending.rowKey), unchanged(pending)),
        )
        .returning(claimColumns);
      return row === undefined ? null : toClaim(row);
    },

    async forgetBlob(row) {
      const gone = await db
        .delete(sessionStateBlobs)
        .where(every(s.blobWhere(row.sessionId, row.engine, row.rowKey), unchanged(row)))
        .returning({ rowKey: sessionStateBlobs.blobKey });
      return gone.length > 0;
    },

    async unsettledBlobs(before) {
      const rows = await db
        .select(claimColumns)
        .from(sessionStateBlobs)
        .where(
          every(
            eq(sessionStateBlobs.workspaceId, s.workspaceId),
            or(
              eq(sessionStateBlobs.status, 'deleting'),
              every(
                eq(sessionStateBlobs.status, 'pending'),
                lt(sessionStateBlobs.updatedAt, before),
              ),
            ) ?? sql`false`,
          ),
        )
        .orderBy(asc(sessionStateBlobs.updatedAt), asc(sessionStateBlobs.blobKey));
      return rows.map(toClaim);
    },
  };
}

/** The read half of the blob methods. */
function createBlobReads(
  db: Database,
  s: ScopedSessionState,
): Pick<BlobMethods, 'getBlob' | 'listBlobs' | 'referencedObjectIds'> {
  return {
    async getBlob(sessionId, engine, blobKey) {
      const rows = await db
        .select(readableColumns)
        .from(sessionStateBlobs)
        .where(
          every(s.blobWhere(sessionId, engine, blobKey), eq(sessionStateBlobs.status, 'ready')),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listBlobs(sessionId) {
      return db
        .select(readableColumns)
        .from(sessionStateBlobs)
        .where(
          every(
            eq(sessionStateBlobs.workspaceId, s.workspaceId),
            eq(sessionStateBlobs.sessionId, sessionId),
            eq(sessionStateBlobs.status, 'ready'),
          ),
        )
        .orderBy(asc(sessionStateBlobs.blobKey));
    },

    async referencedObjectIds(objectIds) {
      if (objectIds.length === 0) return [];
      const rows = await db
        .select({ objectId: sessionStateBlobs.objectId })
        .from(sessionStateBlobs)
        .where(
          every(
            eq(sessionStateBlobs.workspaceId, s.workspaceId),
            inArray(sessionStateBlobs.objectId, [...objectIds]),
          ),
        );
      return rows.map((found) => found.objectId);
    },
  };
}

/** The blob half of the repository, over one workspace, less the purge. */
export function createSessionStateBlobs(db: Database, s: ScopedSessionState): BlobMethods {
  return { ...createBlobClaims(db, s), ...createBlobReads(db, s) };
}
