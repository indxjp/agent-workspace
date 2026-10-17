/**
 * The tenant-scoped PostgreSQL side of the one engine-scoped session store (ENG-06, #305).
 *
 * Five operations over a stream and two over a blob, and they are exactly the set the engines this
 * platform has researched need:
 *
 *   * `append` — idempotent by `entryKey`, because the Agent SDK's retries redeliver a batch;
 *   * `list` — cursored, because a resume reads a whole conversation back;
 *   * `deleteLast` — the OpenAI Agents SDK's `popItem`;
 *   * `replaceAll` — its `clearSession` followed by a rewrite;
 *   * `deleteStream` — the Agent SDK's `delete(key)`;
 *   * `putBlob` / `getBlob` metadata — an ACP agent's state directory, snapshotted.
 *
 * There is deliberately no sixth stream operation. The platform reads no field of an entry, so
 * there is nothing else it could offer that would not be an engine's own business.
 *
 * ## Why every write takes the advisory lock
 *
 * `append` is read-modify-write: it has to know the stream's current highest sequence and which of
 * the incoming keys are already present. `replaceAll` and `deleteLast` are too. The lock is taken on
 * the four key components inside the same transaction, the way `session-transcripts.ts` already
 * does, so two control-plane replicas appending to one stream are serialised by PostgreSQL rather
 * than by a promise chain that is only one process wide.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, max, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import type { EngineId } from '../schema/agents.js';
import { sessionStateBlobs } from '../schema/session-state-blobs.js';
import { sessionStateEntries } from '../schema/session-state-entries.js';
import { sessionStateStreams } from '../schema/session-state-streams.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

/** Which stream: the platform's session row, the engine that wrote it, and the opaque key. */
export interface SessionStateStreamKey {
  readonly sessionId: string;
  readonly engine: EngineId;
  /** Adapter-defined. Claude: `projectKey` + `/` + `subpath`. Never interpreted here. */
  readonly streamKey: string;
}

/** One entry as a caller appends it. `entryKey` absent means "this entry has no identity". */
export interface SessionStateEntryInput {
  readonly entryKey?: string | undefined;
  readonly entry: Readonly<Record<string, unknown>>;
}

/** One entry as it is stored, with the sequence a cursor pages by. */
export interface StoredSessionStateEntry {
  readonly sequence: number;
  readonly entryKey: string | null;
  readonly entry: Readonly<Record<string, unknown>>;
}

/** One stream, as {@link SessionStateRepository.listStreams} reports it. */
export interface StoredSessionStateStream {
  readonly engine: EngineId;
  readonly streamKey: string;
  /** Integer epoch milliseconds of the last write. The SDK's `listSessions` calls this `mtime`. */
  readonly updatedAt: number;
}

/** What is recorded about one blob. The bytes themselves live in the object store. */
export interface StoredSessionStateBlob {
  readonly blobKey: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** What {@link SessionStateRepository.putBlob} records. `storageKey` is derived by the caller. */
export interface SessionStateBlobInput {
  readonly engine: EngineId;
  readonly blobKey: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SessionStateRepository {
  /**
   * Persist a batch, upserting on `entryKey` and appending keyless entries.
   *
   * Creates the stream row if it does not exist, so an empty batch is still the difference between
   * "this stream exists and is empty" and "this stream was never written" — the distinction a
   * resume turns on.
   */
  append(key: SessionStateStreamKey, entries: readonly SessionStateEntryInput[]): Promise<void>;
  /**
   * Everything in the stream after `afterSequence`, in order, or `null` when the stream is unknown.
   *
   * `null` and `[]` are different answers, and only the second is resumable.
   */
  list(
    key: SessionStateStreamKey,
    page?: { readonly afterSequence?: number | undefined; readonly limit?: number | undefined },
  ): Promise<readonly StoredSessionStateEntry[] | null>;
  /** Remove the highest-sequence entry. Answers how many rows went, so 0 means an empty stream. */
  deleteLast(key: SessionStateStreamKey): Promise<number>;
  /** Replace every entry with exactly these, renumbered from 1. Creates the stream if absent. */
  replaceAll(key: SessionStateStreamKey, entries: readonly SessionStateEntryInput[]): Promise<void>;
  /** Remove one stream and its entries. Idempotent. */
  deleteStream(key: SessionStateStreamKey): Promise<void>;
  /** Every stream of one session, newest write first. */
  listStreams(sessionId: string): Promise<readonly StoredSessionStateStream[]>;
  /** Record one blob's location and digest, replacing any previous record under the same key. */
  putBlob(sessionId: string, blob: SessionStateBlobInput): Promise<void>;
  /** What is recorded about one blob, or `null`. */
  getBlob(
    sessionId: string,
    engine: EngineId,
    blobKey: string,
  ): Promise<StoredSessionStateBlob | null>;
  /** Every blob of one session, for cleanup. */
  listBlobs(sessionId: string): Promise<readonly StoredSessionStateBlob[]>;
  /**
   * Retention: remove every stream (with its entries) and every blob record of this workspace whose
   * last write is before `before`. The same rule the legacy `session_transcripts` purge applies, over
   * the same `updated_at`, so one policy covers both stores.
   */
  purgeBefore(before: Date): Promise<SessionStatePurge>;
}

/** What one {@link SessionStateRepository.purgeBefore} pass removed. */
interface SessionStatePurge {
  /** Streams whose last write was before the cutoff, removed with their entries. */
  readonly streams: number;
  /** The entries those streams held. */
  readonly entries: number;
  /** The blob records removed. The caller deletes their bytes from the object store. */
  readonly blobs: readonly StoredSessionStateBlob[];
}

export interface SessionStateRepositoryProvider {
  forScope(scope: WorkspaceScope): SessionStateRepository;
}

function every(...predicates: readonly SQL[]): SQL {
  const combined = and(...predicates);
  if (combined === undefined) throw new Error('the session-state predicate could not be built');
  return combined;
}

/**
 * The handle a `db.transaction` callback is given.
 *
 * Derived from {@link Database} rather than written out: `PgTransaction`'s own type parameters are
 * the driver's and the schema's, and naming them here would be a second declaration of the client
 * that a driver upgrade could make disagree with the first.
 */
type SessionStateTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_state_entries.entry is not a JSON object');
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Rows per multi-row `INSERT`. Seven bind parameters a row keeps a chunk far below PostgreSQL's
 * 65 535-parameter ceiling while still turning a 5 000-entry batch into five statements.
 */
const INSERT_CHUNK_ROWS = 1_000;

/** The default page size of {@link SessionStateRepository.list}, and its ceiling. */
export const SESSION_STATE_PAGE_LIMIT = 2_000;

export function createDatabaseSessionStateRepositoryProvider(
  db: Database,
): SessionStateRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'SessionStateRepositoryProvider');

      const streamWhere = (key: SessionStateStreamKey): SQL =>
        every(
          eq(sessionStateStreams.workspaceId, checked.workspaceId),
          eq(sessionStateStreams.sessionId, key.sessionId),
          eq(sessionStateStreams.engine, key.engine),
          eq(sessionStateStreams.streamKey, key.streamKey),
        );

      const entryWhere = (key: SessionStateStreamKey): SQL =>
        every(
          eq(sessionStateEntries.workspaceId, checked.workspaceId),
          eq(sessionStateEntries.sessionId, key.sessionId),
          eq(sessionStateEntries.engine, key.engine),
          eq(sessionStateEntries.streamKey, key.streamKey),
        );

      const row = (key: SessionStateStreamKey) => ({
        workspaceId: checked.workspaceId,
        sessionId: key.sessionId,
        engine: key.engine,
        streamKey: key.streamKey,
      });

      /**
       * Serialise every writer of one stream.
       *
       * The same construction `session-transcripts.ts` uses, and for the same reason its own
       * comment gives: JSON array framing keeps the four components unambiguous whatever characters
       * an adapter put in `streamKey`, and PostgreSQL text cannot carry the NUL byte that would
       * otherwise need escaping.
       */
      const lock = async (
        tx: SessionStateTransaction,
        key: SessionStateStreamKey,
      ): Promise<void> => {
        const lockKey = JSON.stringify([
          checked.workspaceId,
          key.sessionId,
          key.engine,
          key.streamKey,
        ]);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      };

      const touchStream = async (
        tx: SessionStateTransaction,
        key: SessionStateStreamKey,
      ): Promise<void> => {
        await tx
          .insert(sessionStateStreams)
          .values(row(key))
          .onConflictDoUpdate({
            target: [
              sessionStateStreams.workspaceId,
              sessionStateStreams.sessionId,
              sessionStateStreams.engine,
              sessionStateStreams.streamKey,
            ],
            set: { updatedAt: sql`now()` },
          });
      };

      /**
       * Insert rows whose sequences are already known, one multi-row `INSERT` per chunk.
       *
       * The caller holds the stream's advisory lock for the whole transaction, so batching changes
       * how many round trips the lock is held across and nothing about what another writer can
       * observe: every chunk commits or none does. The chunk bound keeps one statement under
       * PostgreSQL's 65 535 bind-parameter ceiling — seven parameters a row, and
       * `MAX_SESSION_STATE_BATCH_ENTRIES` is 5 000.
       */
      const insertRows = async (
        tx: SessionStateTransaction,
        key: SessionStateStreamKey,
        rows: readonly {
          readonly sequence: number;
          readonly entryKey: string | null;
          readonly entry: Readonly<Record<string, unknown>>;
        }[],
      ): Promise<void> => {
        for (let at = 0; at < rows.length; at += INSERT_CHUNK_ROWS) {
          await tx
            .insert(sessionStateEntries)
            .values(rows.slice(at, at + INSERT_CHUNK_ROWS).map((one) => ({ ...row(key), ...one })));
        }
      };

      const insertEntries = async (
        tx: SessionStateTransaction,
        key: SessionStateStreamKey,
        entries: readonly SessionStateEntryInput[],
        firstSequence: number,
      ): Promise<void> => {
        await insertRows(
          tx,
          key,
          entries.map((entry, index) => ({
            sequence: firstSequence + index,
            entryKey: entry.entryKey ?? null,
            entry: entry.entry,
          })),
        );
      };

      return {
        async append(key, entries) {
          await db.transaction(async (tx) => {
            await lock(tx, key);
            await touchStream(tx, key);
            if (entries.length === 0) return;

            const highest = await tx
              .select({ value: max(sessionStateEntries.sequence) })
              .from(sessionStateEntries)
              .where(entryWhere(key));
            let next = (highest[0]?.value ?? 0) + 1;

            const keys = [
              ...new Set(
                entries
                  .map((entry) => entry.entryKey)
                  .filter((value): value is string => value !== undefined),
              ),
            ];
            const placed = new Map<string, number>();
            if (keys.length > 0) {
              const known = await tx
                .select({
                  entryKey: sessionStateEntries.entryKey,
                  sequence: sessionStateEntries.sequence,
                })
                .from(sessionStateEntries)
                .where(
                  every(
                    entryWhere(key),
                    isNotNull(sessionStateEntries.entryKey),
                    inArray(sessionStateEntries.entryKey, keys),
                  ),
                );
              for (const found of known) {
                if (found.entryKey !== null) placed.set(found.entryKey, found.sequence);
              }
            }

            // New rows are collected and inserted in one batch at the end. A key repeated inside
            // this same batch lands on its pending row rather than on the table, so the batch
            // still stores one row per key, at the position of the key's first delivery.
            const pending: {
              sequence: number;
              entryKey: string | null;
              entry: Readonly<Record<string, unknown>>;
            }[] = [];
            const pendingByKey = new Map<string, number>();
            for (const entry of entries) {
              const entryKey = entry.entryKey;
              const queued = entryKey === undefined ? undefined : pendingByKey.get(entryKey);
              const pendingRow = queued === undefined ? undefined : pending[queued];
              if (pendingRow !== undefined) {
                pendingRow.entry = entry.entry;
                continue;
              }
              const at = entryKey === undefined ? undefined : placed.get(entryKey);
              if (at !== undefined) {
                // Upserted **in place**: a transcript is a chain and a redelivery must not move an
                // entry to the end. R-01 §7 requires the upsert; keeping the sequence is what keeps
                // the order the engine produced.
                await tx
                  .update(sessionStateEntries)
                  .set({ entry: entry.entry })
                  .where(every(entryWhere(key), eq(sessionStateEntries.sequence, at)));
                continue;
              }
              if (entryKey !== undefined) pendingByKey.set(entryKey, pending.length);
              pending.push({ sequence: next, entryKey: entryKey ?? null, entry: entry.entry });
              next += 1;
            }
            await insertRows(tx, key, pending);
          });
        },

        async list(key, page) {
          const known = await db
            .select({ streamKey: sessionStateStreams.streamKey })
            .from(sessionStateStreams)
            .where(streamWhere(key))
            .limit(1);
          if (known.length === 0) return null;
          const after = page?.afterSequence;
          const limit = Math.min(page?.limit ?? SESSION_STATE_PAGE_LIMIT, SESSION_STATE_PAGE_LIMIT);
          const rows = await db
            .select({
              sequence: sessionStateEntries.sequence,
              entryKey: sessionStateEntries.entryKey,
              entry: sessionStateEntries.entry,
            })
            .from(sessionStateEntries)
            .where(
              after === undefined
                ? entryWhere(key)
                : every(entryWhere(key), gt(sessionStateEntries.sequence, after)),
            )
            .orderBy(asc(sessionStateEntries.sequence))
            .limit(limit);
          return rows.map((found) => ({
            sequence: found.sequence,
            entryKey: found.entryKey,
            entry: jsonObject(found.entry),
          }));
        },

        async deleteLast(key) {
          return db.transaction(async (tx) => {
            await lock(tx, key);
            const highest = await tx
              .select({ value: max(sessionStateEntries.sequence) })
              .from(sessionStateEntries)
              .where(entryWhere(key));
            const last = highest[0]?.value ?? null;
            if (last === null) return 0;
            const removed = await tx
              .delete(sessionStateEntries)
              .where(every(entryWhere(key), eq(sessionStateEntries.sequence, last)))
              .returning({ sequence: sessionStateEntries.sequence });
            await touchStream(tx, key);
            return removed.length;
          });
        },

        async replaceAll(key, entries) {
          await db.transaction(async (tx) => {
            await lock(tx, key);
            await touchStream(tx, key);
            await tx.delete(sessionStateEntries).where(entryWhere(key));
            await insertEntries(tx, key, entries, 1);
          });
        },

        async deleteStream(key) {
          // Entries cascade through `session_state_entries_stream_fk`.
          await db.delete(sessionStateStreams).where(streamWhere(key));
        },

        async listStreams(sessionId) {
          const rows = await db
            .select({
              engine: sessionStateStreams.engine,
              streamKey: sessionStateStreams.streamKey,
              updatedAt: sessionStateStreams.updatedAt,
            })
            .from(sessionStateStreams)
            .where(
              every(
                eq(sessionStateStreams.workspaceId, checked.workspaceId),
                eq(sessionStateStreams.sessionId, sessionId),
              ),
            )
            .orderBy(desc(sessionStateStreams.updatedAt), asc(sessionStateStreams.streamKey));
          return rows.map((found) => ({
            engine: found.engine,
            streamKey: found.streamKey,
            updatedAt: found.updatedAt.getTime(),
          }));
        },

        async putBlob(sessionId, blob) {
          await db
            .insert(sessionStateBlobs)
            .values({
              workspaceId: checked.workspaceId,
              sessionId,
              engine: blob.engine,
              blobKey: blob.blobKey,
              storageKey: blob.storageKey,
              sizeBytes: blob.sizeBytes,
              sha256: blob.sha256,
            })
            .onConflictDoUpdate({
              target: [
                sessionStateBlobs.workspaceId,
                sessionStateBlobs.sessionId,
                sessionStateBlobs.engine,
                sessionStateBlobs.blobKey,
              ],
              set: {
                storageKey: blob.storageKey,
                sizeBytes: blob.sizeBytes,
                sha256: blob.sha256,
                updatedAt: sql`now()`,
              },
            });
        },

        async getBlob(sessionId, engine, blobKey) {
          const rows = await db
            .select({
              blobKey: sessionStateBlobs.blobKey,
              storageKey: sessionStateBlobs.storageKey,
              sizeBytes: sessionStateBlobs.sizeBytes,
              sha256: sessionStateBlobs.sha256,
            })
            .from(sessionStateBlobs)
            .where(
              every(
                eq(sessionStateBlobs.workspaceId, checked.workspaceId),
                eq(sessionStateBlobs.sessionId, sessionId),
                eq(sessionStateBlobs.engine, engine),
                eq(sessionStateBlobs.blobKey, blobKey),
              ),
            )
            .limit(1);
          return rows[0] ?? null;
        },

        async listBlobs(sessionId) {
          return db
            .select({
              blobKey: sessionStateBlobs.blobKey,
              storageKey: sessionStateBlobs.storageKey,
              sizeBytes: sessionStateBlobs.sizeBytes,
              sha256: sessionStateBlobs.sha256,
            })
            .from(sessionStateBlobs)
            .where(
              every(
                eq(sessionStateBlobs.workspaceId, checked.workspaceId),
                eq(sessionStateBlobs.sessionId, sessionId),
              ),
            )
            .orderBy(asc(sessionStateBlobs.blobKey));
        },

        async purgeBefore(before) {
          return db.transaction(async (tx) => {
            const stale = every(
              eq(sessionStateStreams.workspaceId, checked.workspaceId),
              lt(sessionStateStreams.updatedAt, before),
            );
            // Counted before the streams go: the entries cascade through
            // `session_state_entries_stream_fk`, and a cascade reports nothing.
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
            const streams = await tx
              .delete(sessionStateStreams)
              .where(stale)
              .returning({ streamKey: sessionStateStreams.streamKey });
            const blobs = await tx
              .delete(sessionStateBlobs)
              .where(
                every(
                  eq(sessionStateBlobs.workspaceId, checked.workspaceId),
                  lt(sessionStateBlobs.updatedAt, before),
                ),
              )
              .returning({
                blobKey: sessionStateBlobs.blobKey,
                storageKey: sessionStateBlobs.storageKey,
                sizeBytes: sessionStateBlobs.sizeBytes,
                sha256: sessionStateBlobs.sha256,
              });
            return { streams: streams.length, entries: counted[0]?.value ?? 0, blobs };
          });
        },
      };
    },
  };
}
