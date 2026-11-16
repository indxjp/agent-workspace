import { eq, max, sql, type SQL } from 'drizzle-orm';

import type { EngineId } from '../../schema/agents.js';
import { sessionStateBlobs } from '../../schema/session-state-blobs.js';
import { sessionStateEntries } from '../../schema/session-state-entries.js';
import { sessionStateStreams } from '../../schema/session-state-streams.js';
import { every, type SessionStateTransaction } from './sql.js';
import type { SessionStateEntryInput, SessionStateStreamKey } from './types.js';

/**
 * Rows per multi-row `INSERT`. Seven bind parameters a row keeps a chunk far below PostgreSQL's
 * 65 535-parameter ceiling while still turning a 5 000-entry batch into five statements.
 */
const INSERT_CHUNK_ROWS = 1_000;

/** One entry row whose sequence is already known. */
export interface SessionStateEntryRow {
  readonly sequence: number;
  readonly entryKey: string | null;
  readonly entry: Readonly<Record<string, unknown>>;
}

const streamWhere = (workspaceId: string, key: SessionStateStreamKey): SQL =>
  every(
    eq(sessionStateStreams.workspaceId, workspaceId),
    eq(sessionStateStreams.sessionId, key.sessionId),
    eq(sessionStateStreams.engine, key.engine),
    eq(sessionStateStreams.streamKey, key.streamKey),
  );

const entryWhere = (workspaceId: string, key: SessionStateStreamKey): SQL =>
  every(
    eq(sessionStateEntries.workspaceId, workspaceId),
    eq(sessionStateEntries.sessionId, key.sessionId),
    eq(sessionStateEntries.engine, key.engine),
    eq(sessionStateEntries.streamKey, key.streamKey),
  );

const blobWhere = (workspaceId: string, sessionId: string, engine: EngineId, blobKey: string) =>
  every(
    eq(sessionStateBlobs.workspaceId, workspaceId),
    eq(sessionStateBlobs.sessionId, sessionId),
    eq(sessionStateBlobs.engine, engine),
    eq(sessionStateBlobs.blobKey, blobKey),
  );

const row = (workspaceId: string, key: SessionStateStreamKey) => ({
  workspaceId,
  sessionId: key.sessionId,
  engine: key.engine,
  streamKey: key.streamKey,
});

/**
 * A transaction-scoped advisory lock on `parts`, the workspace first.
 *
 * The same construction `session-transcripts.ts` uses, and for the same reason its own comment
 * gives: JSON array framing keeps the components unambiguous whatever characters an adapter put in
 * `streamKey`, and PostgreSQL text cannot carry the NUL byte that would otherwise need escaping.
 */
async function xactLock(tx: SessionStateTransaction, parts: readonly string[]): Promise<void> {
  const lockKey = JSON.stringify(parts);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

async function touchStream(
  tx: SessionStateTransaction,
  workspaceId: string,
  key: SessionStateStreamKey,
): Promise<void> {
  await tx
    .insert(sessionStateStreams)
    .values(row(workspaceId, key))
    .onConflictDoUpdate({
      target: [
        sessionStateStreams.workspaceId,
        sessionStateStreams.sessionId,
        sessionStateStreams.engine,
        sessionStateStreams.streamKey,
      ],
      set: { updatedAt: sql`now()` },
    });
}

/**
 * Insert rows whose sequences are already known, one multi-row `INSERT` per chunk.
 *
 * The caller holds the stream's advisory lock for the whole transaction, so batching changes
 * how many round trips the lock is held across and nothing about what another writer can
 * observe: every chunk commits or none does. The chunk bound keeps one statement under
 * PostgreSQL's 65 535 bind-parameter ceiling — seven parameters a row, and
 * `MAX_SESSION_STATE_BATCH_ENTRIES` is 5 000.
 */
async function insertRows(
  tx: SessionStateTransaction,
  workspaceId: string,
  key: SessionStateStreamKey,
  rows: readonly SessionStateEntryRow[],
): Promise<void> {
  for (let at = 0; at < rows.length; at += INSERT_CHUNK_ROWS) {
    await tx
      .insert(sessionStateEntries)
      .values(
        rows.slice(at, at + INSERT_CHUNK_ROWS).map((one) => ({ ...row(workspaceId, key), ...one })),
      );
  }
}

async function highestSequence(
  tx: SessionStateTransaction,
  workspaceId: string,
  key: SessionStateStreamKey,
): Promise<number | null> {
  const highest = await tx
    .select({ value: max(sessionStateEntries.sequence) })
    .from(sessionStateEntries)
    .where(entryWhere(workspaceId, key));
  return highest[0]?.value ?? null;
}

/** The predicates, locks and shared writes of one workspace's session state. */
export type ScopedSessionState = ReturnType<typeof scopedSessionState>;

export function scopedSessionState(workspaceId: string) {
  type Tx = SessionStateTransaction;
  type Key = SessionStateStreamKey;
  return {
    workspaceId,
    streamWhere: (key: Key): SQL => streamWhere(workspaceId, key),
    entryWhere: (key: Key): SQL => entryWhere(workspaceId, key),
    blobWhere: (sessionId: string, engine: EngineId, blobKey: string): SQL =>
      blobWhere(workspaceId, sessionId, engine, blobKey),
    /** Serialise every writer of one stream. */
    lockStream: (tx: Tx, key: Key): Promise<void> =>
      xactLock(tx, [workspaceId, key.sessionId, key.engine, key.streamKey]),
    /** Two writers of one blob key would each read the other's row as the one they replace. */
    lockBlobKey: (tx: Tx, sessionId: string, engine: EngineId, blobKey: string): Promise<void> =>
      xactLock(tx, [workspaceId, sessionId, engine, 'blob', blobKey]),
    touchStream: (tx: Tx, key: Key): Promise<void> => touchStream(tx, workspaceId, key),
    insertRows: (tx: Tx, key: Key, rows: readonly SessionStateEntryRow[]): Promise<void> =>
      insertRows(tx, workspaceId, key, rows),
    /** Insert `entries` numbered from 1, the way `replaceAll` rewrites a stream. */
    insertEntries: (tx: Tx, key: Key, entries: readonly SessionStateEntryInput[]): Promise<void> =>
      insertRows(
        tx,
        workspaceId,
        key,
        entries.map((entry, index) => ({
          sequence: index + 1,
          entryKey: entry.entryKey ?? null,
          entry: entry.entry,
        })),
      ),
    /** The stream's highest sequence, or `null` when it holds no entry. */
    highestSequence: (tx: Tx, key: Key): Promise<number | null> =>
      highestSequence(tx, workspaceId, key),
  };
}
