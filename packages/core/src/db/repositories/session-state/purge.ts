import { eq, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { sessionStateBlobs } from '../../schema/session-state-blobs.js';
import { sessionStateEntries } from '../../schema/session-state-entries.js';
import { sessionStateStreams } from '../../schema/session-state-streams.js';
import type { ScopedSessionState } from './scoped.js';
import { claimColumns, every, newSideKey, toClaim, type SessionStateTransaction } from './sql.js';
import type { SessionStateBlobClaim, SessionStateRepository } from './types.js';

/**
 * The entries the stale streams hold. Counted before the streams go: the entries cascade through
 * `session_state_entries_stream_fk`, and a cascade reports nothing.
 */
async function countStaleEntries(tx: SessionStateTransaction, stale: SQL): Promise<number> {
  const counted = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(sessionStateEntries)
    .innerJoin(
      sessionStateStreams,
      every(
        eq(sessionStateEntries.workspaceId, sessionStateStreams.workspaceId),
        eq(sessionStateEntries.sessionId, sessionStateStreams.sessionId),
        eq(sessionStateEntries.engine, sessionStateStreams.engine),
        eq(sessionStateEntries.streamKey, sessionStateStreams.streamKey),
      ),
    )
    .where(stale);
  return counted[0]?.value ?? 0;
}

/** Delete the stale streams, answering the session of each one that went. */
async function deleteStaleStreams(
  tx: SessionStateTransaction,
  stale: SQL,
): Promise<readonly { readonly sessionId: string }[]> {
  return tx
    .delete(sessionStateStreams)
    .where(stale)
    .returning({ sessionId: sessionStateStreams.sessionId });
}

/**
 * A session whose every stream went is gone from this store: its conversation was purged, so the
 * caller removes what lives as long as it (ADR-0146 D6 attachments).
 */
async function sessionsLeftEmpty(
  tx: SessionStateTransaction,
  workspaceId: string,
  streams: readonly { readonly sessionId: string }[],
): Promise<readonly string[]> {
  const touched = [...new Set(streams.map((row) => row.sessionId))];
  const kept =
    touched.length === 0
      ? []
      : await tx
          .selectDistinct({ sessionId: sessionStateStreams.sessionId })
          .from(sessionStateStreams)
          .where(
            every(
              eq(sessionStateStreams.workspaceId, workspaceId),
              inArray(sessionStateStreams.sessionId, touched),
            ),
          );
  const keptIds = new Set(kept.map((row) => row.sessionId));
  return touched.filter((id) => !keptIds.has(id));
}

/**
 * Marked before their bytes go, and a ready row moved off its key so the key is free for the next
 * save; a pending row already waits aside, and a purged reservation is never confirmed. Rows
 * already `deleting` are the cleanup job's.
 */
async function markStaleBlobsDeleting(
  tx: SessionStateTransaction,
  workspaceId: string,
  before: Date,
): Promise<readonly SessionStateBlobClaim[]> {
  const blobs = await tx
    .update(sessionStateBlobs)
    .set({
      blobKey: sql`case when ${sessionStateBlobs.status} = 'ready' then ${newSideKey} else ${sessionStateBlobs.blobKey} end`,
      status: 'deleting',
    })
    .where(
      every(
        eq(sessionStateBlobs.workspaceId, workspaceId),
        ne(sessionStateBlobs.status, 'deleting'),
        lt(sessionStateBlobs.updatedAt, before),
      ),
    )
    .returning(claimColumns);
  return blobs.map(toClaim);
}

/** Retention over one workspace: {@link SessionStateRepository.purgeBefore}. */
export function createSessionStatePurge(
  db: Database,
  s: ScopedSessionState,
): Pick<SessionStateRepository, 'purgeBefore'> {
  return {
    async purgeBefore(before) {
      return db.transaction(async (tx) => {
        const stale = every(
          eq(sessionStateStreams.workspaceId, s.workspaceId),
          lt(sessionStateStreams.updatedAt, before),
        );
        const entries = await countStaleEntries(tx, stale);
        const streams = await deleteStaleStreams(tx, stale);
        const sessionIds = await sessionsLeftEmpty(tx, s.workspaceId, streams);
        const blobs = await markStaleBlobsDeleting(tx, s.workspaceId, before);
        return { streams: streams.length, entries, blobs, sessionIds };
      });
    },
  };
}
