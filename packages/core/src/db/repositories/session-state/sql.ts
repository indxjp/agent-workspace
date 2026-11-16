import { and, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { sessionStateBlobs } from '../../schema/session-state-blobs.js';
import { isSidePath, SIDE_PATH_ROOT } from '../../side-paths.js';
import type { SessionStateBlobClaim } from './types.js';

/** A side key for a blob row. A caller's key starts with a letter or a digit, so none collides. */
export const blobSideKey = (id: string): string => `${SIDE_PATH_ROOT}/${id}`;

/** Refuse a side key where a caller's blob key is expected. */
export function assertCallerBlobKey(blobKey: string): void {
  if (isSidePath(blobKey)) {
    throw new Error('a session-state blob cannot be saved under a side key');
  }
}

export const readableColumns = {
  blobKey: sessionStateBlobs.blobKey,
  storageKey: sessionStateBlobs.storageKey,
  objectId: sessionStateBlobs.objectId,
  sizeBytes: sessionStateBlobs.sizeBytes,
  sha256: sessionStateBlobs.sha256,
};

/**
 * A pending row's reservation token: the exact time of its reservation, as text, as the file
 * catalog keeps it. A `ready` or `deleting` row has none.
 */
const blobReservationToken = sql<
  string | null
>`case when ${sessionStateBlobs.status} = 'pending' then extract(epoch from ${sessionStateBlobs.updatedAt})::text end`;

export const claimColumns = {
  sessionId: sessionStateBlobs.sessionId,
  engine: sessionStateBlobs.engine,
  rowKey: sessionStateBlobs.blobKey,
  status: sessionStateBlobs.status,
  objectId: sessionStateBlobs.objectId,
  storageKey: sessionStateBlobs.storageKey,
  reservationToken: blobReservationToken,
};

export function toClaim(
  row: Omit<SessionStateBlobClaim, 'status'> & { readonly status: string },
): SessionStateBlobClaim {
  if (row.status !== 'pending' && row.status !== 'deleting') {
    throw new Error(`a ${row.status} session-state blob row is not a claim`);
  }
  return { ...row, status: row.status };
}

/** The row is the one `claim` names: still in its status and, for a pending row, its reservation. */
export const unchanged = (claim: SessionStateBlobClaim): SQL =>
  claim.status === 'deleting'
    ? sql`${sessionStateBlobs.status} = 'deleting'`
    : claim.reservationToken === null
      ? sql`false`
      : sql`(${sessionStateBlobs.status} = 'pending' and ${blobReservationToken} = ${claim.reservationToken})`;

/** A new side key, made by the database inside the statement that moves a row aside. */
export const newSideKey = sql`${`${SIDE_PATH_ROOT}/`} || gen_random_uuid()::text`;

export function every(...predicates: readonly SQL[]): SQL {
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
export type SessionStateTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_state_entries.entry is not a JSON object');
  }
  return value as Readonly<Record<string, unknown>>;
}
