import { asc, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { sessionStateEntries } from '../../schema/session-state-entries.js';
import { sessionStateStreams } from '../../schema/session-state-streams.js';
import type { ScopedSessionState, SessionStateEntryRow } from './scoped.js';
import { every, jsonObject, type SessionStateTransaction } from './sql.js';
import type {
  SessionStateEntryInput,
  SessionStateRepository,
  SessionStateStreamKey,
  StoredSessionStateEntry,
  StoredSessionStateStream,
} from './types.js';

/** The default page size of {@link SessionStateRepository.list}, and its ceiling. */
export const SESSION_STATE_PAGE_LIMIT = 2_000;

type Entry = SessionStateEntryInput['entry'];

/** What one `append` writes: in-place updates first, then one batch of new rows. */
interface AppendPlan {
  readonly updates: readonly { readonly sequence: number; readonly entry: Entry }[];
  readonly inserts: readonly SessionStateEntryRow[];
}

/** The sequence each of the batch's keys already holds in the stream. */
async function placedSequences(
  tx: SessionStateTransaction,
  s: ScopedSessionState,
  key: SessionStateStreamKey,
  entries: readonly SessionStateEntryInput[],
): Promise<Map<string, number>> {
  const keys = [
    ...new Set(
      entries
        .map((entry) => entry.entryKey)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  const placed = new Map<string, number>();
  if (keys.length === 0) return placed;
  const known = await tx
    .select({
      entryKey: sessionStateEntries.entryKey,
      sequence: sessionStateEntries.sequence,
    })
    .from(sessionStateEntries)
    .where(
      every(
        s.entryWhere(key),
        isNotNull(sessionStateEntries.entryKey),
        inArray(sessionStateEntries.entryKey, keys),
      ),
    );
  for (const found of known) {
    if (found.entryKey !== null) placed.set(found.entryKey, found.sequence);
  }
  return placed;
}

const lookup = <T>(map: ReadonlyMap<string, T>, entryKey: string | undefined): T | undefined =>
  entryKey === undefined ? undefined : map.get(entryKey);

/**
 * Decide what `append` writes for `entries`, given the sequence each key already holds (`placed`)
 * and the stream's first free sequence.
 *
 * New rows are collected and inserted in one batch at the end. A key repeated inside this same
 * batch lands on its pending row rather than on the table, so the batch still stores one row per
 * key, at the position of the key's first delivery.
 */
export function planAppend(
  entries: readonly SessionStateEntryInput[],
  placed: ReadonlyMap<string, number>,
  firstSequence: number,
): AppendPlan {
  const updates: { readonly sequence: number; readonly entry: Entry }[] = [];
  const pending: { sequence: number; entryKey: string | null; entry: Entry }[] = [];
  const pendingByKey = new Map<string, number>();
  let next = firstSequence;
  for (const entry of entries) {
    const queued = lookup(pendingByKey, entry.entryKey);
    const pendingRow = queued === undefined ? undefined : pending[queued];
    if (pendingRow !== undefined) {
      pendingRow.entry = entry.entry;
      continue;
    }
    const at = lookup(placed, entry.entryKey);
    if (at !== undefined) {
      updates.push({ sequence: at, entry: entry.entry });
      continue;
    }
    if (entry.entryKey !== undefined) pendingByKey.set(entry.entryKey, pending.length);
    pending.push({ sequence: next, entryKey: entry.entryKey ?? null, entry: entry.entry });
    next += 1;
  }
  return { updates, inserts: pending };
}

async function append(
  db: Database,
  s: ScopedSessionState,
  key: SessionStateStreamKey,
  entries: readonly SessionStateEntryInput[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await s.lockStream(tx, key);
    await s.touchStream(tx, key);
    if (entries.length === 0) return;
    const next = ((await s.highestSequence(tx, key)) ?? 0) + 1;
    const placed = await placedSequences(tx, s, key, entries);
    const { updates, inserts } = planAppend(entries, placed, next);
    for (const update of updates) {
      // Upserted **in place**: a transcript is a chain and a redelivery must not move an
      // entry to the end. R-01 §7 requires the upsert; keeping the sequence is what keeps
      // the order the engine produced.
      await tx
        .update(sessionStateEntries)
        .set({ entry: update.entry })
        .where(every(s.entryWhere(key), eq(sessionStateEntries.sequence, update.sequence)));
    }
    await s.insertRows(tx, key, inserts);
  });
}

async function list(
  db: Database,
  s: ScopedSessionState,
  key: SessionStateStreamKey,
  page: Parameters<SessionStateRepository['list']>[1],
): Promise<readonly StoredSessionStateEntry[] | null> {
  const known = await db
    .select({ streamKey: sessionStateStreams.streamKey })
    .from(sessionStateStreams)
    .where(s.streamWhere(key))
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
        ? s.entryWhere(key)
        : every(s.entryWhere(key), gt(sessionStateEntries.sequence, after)),
    )
    .orderBy(asc(sessionStateEntries.sequence))
    .limit(limit);
  return rows.map((found) => ({
    sequence: found.sequence,
    entryKey: found.entryKey,
    entry: jsonObject(found.entry),
  }));
}

async function deleteLast(
  db: Database,
  s: ScopedSessionState,
  key: SessionStateStreamKey,
): Promise<number> {
  return db.transaction(async (tx) => {
    await s.lockStream(tx, key);
    const last = await s.highestSequence(tx, key);
    if (last === null) return 0;
    const removed = await tx
      .delete(sessionStateEntries)
      .where(every(s.entryWhere(key), eq(sessionStateEntries.sequence, last)))
      .returning({ sequence: sessionStateEntries.sequence });
    await s.touchStream(tx, key);
    return removed.length;
  });
}

async function replaceAll(
  db: Database,
  s: ScopedSessionState,
  key: SessionStateStreamKey,
  entries: readonly SessionStateEntryInput[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await s.lockStream(tx, key);
    await s.touchStream(tx, key);
    await tx.delete(sessionStateEntries).where(s.entryWhere(key));
    await s.insertEntries(tx, key, entries);
  });
}

async function listStreams(
  db: Database,
  s: ScopedSessionState,
  sessionId: string,
): Promise<readonly StoredSessionStateStream[]> {
  const rows = await db
    .select({
      engine: sessionStateStreams.engine,
      streamKey: sessionStateStreams.streamKey,
      updatedAt: sessionStateStreams.updatedAt,
    })
    .from(sessionStateStreams)
    .where(
      every(
        eq(sessionStateStreams.workspaceId, s.workspaceId),
        eq(sessionStateStreams.sessionId, sessionId),
      ),
    )
    .orderBy(desc(sessionStateStreams.updatedAt), asc(sessionStateStreams.streamKey));
  return rows.map((found) => ({
    engine: found.engine,
    streamKey: found.streamKey,
    updatedAt: found.updatedAt.getTime(),
  }));
}

/** The stream half of the repository, over one workspace. */
export function createSessionStateStreams(
  db: Database,
  s: ScopedSessionState,
): Pick<
  SessionStateRepository,
  'append' | 'list' | 'deleteLast' | 'replaceAll' | 'deleteStream' | 'listStreams'
> {
  return {
    append: (key, entries) => append(db, s, key, entries),
    list: (key, page) => list(db, s, key, page),
    deleteLast: (key) => deleteLast(db, s, key),
    replaceAll: (key, entries) => replaceAll(db, s, key, entries),
    async deleteStream(key) {
      // Entries cascade through `session_state_entries_stream_fk`.
      await db.delete(sessionStateStreams).where(s.streamWhere(key));
    },
    listStreams: (sessionId) => listStreams(db, s, sessionId),
  };
}
