/**
 * The session-state blob rows in memory, for tests: the PostgreSQL repository's rules, held to the
 * same contract (`session-state-blobs.contract.ts`). Only the blob half; a test that needs streams
 * uses the database or the web app's own in-memory state store.
 */
import crypto from 'node:crypto';

import type { EngineId } from '../schema/agents.js';
import {
  assertCallerBlobKey,
  blobSideKey,
  type SessionStateBlobClaim,
  type SessionStateBlobRepository,
  type StoredSessionStateBlob,
} from './session-state.js';

interface Row {
  readonly sessionId: string;
  readonly engine: EngineId;
  readonly rowKey: string;
  readonly status: 'pending' | 'ready' | 'deleting';
  readonly objectId: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** A pending row's reservation; a fresh one each reservation, `null` otherwise. */
  readonly reservationToken: string | null;
  readonly updatedAt: Date;
}

export interface InMemorySessionStateBlobs {
  forWorkspace(workspaceId: string): SessionStateBlobRepository;
}

const idOf = (sessionId: string, engine: EngineId, rowKey: string): string =>
  JSON.stringify([sessionId, engine, rowKey]);

function claimOf(row: Row): SessionStateBlobClaim {
  if (row.status === 'ready') throw new Error('a ready session-state blob row is not a claim');
  return {
    sessionId: row.sessionId,
    engine: row.engine,
    rowKey: row.rowKey,
    status: row.status,
    objectId: row.objectId,
    storageKey: row.storageKey,
    reservationToken: row.reservationToken,
  };
}

const readable = (row: Row): StoredSessionStateBlob => ({
  blobKey: row.rowKey,
  storageKey: row.storageKey,
  objectId: row.objectId,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
});

export function createInMemorySessionStateBlobs(): InMemorySessionStateBlobs {
  const workspaces = new Map<string, Map<string, Row>>();
  const rowsOf = (workspaceId: string): Map<string, Row> => {
    let rows = workspaces.get(workspaceId);
    if (rows === undefined) {
      rows = new Map();
      workspaces.set(workspaceId, rows);
    }
    return rows;
  };

  return {
    forWorkspace(workspaceId) {
      const rows = rowsOf(workspaceId);
      /** The row `claim` names, if it is still in that status and, when pending, that reservation. */
      const current = (claim: SessionStateBlobClaim): Row | null => {
        const row = rows.get(idOf(claim.sessionId, claim.engine, claim.rowKey));
        if (row === undefined || row.status !== claim.status) return null;
        if (row.status === 'pending' && row.reservationToken !== claim.reservationToken) {
          return null;
        }
        return row;
      };
      const put = (row: Row): Row => {
        rows.set(idOf(row.sessionId, row.engine, row.rowKey), row);
        return row;
      };
      const remove = (row: Row): void => {
        rows.delete(idOf(row.sessionId, row.engine, row.rowKey));
      };
      const aside = (row: Row): Row => {
        remove(row);
        return put({
          ...row,
          rowKey: row.status === 'ready' ? blobSideKey(crypto.randomUUID()) : row.rowKey,
          status: 'deleting',
          reservationToken: null,
          updatedAt: new Date(),
        });
      };

      return {
        reserveBlob(sessionId, blob) {
          const row = put({
            sessionId,
            engine: blob.engine,
            rowKey: blobSideKey(blob.objectId),
            status: 'pending',
            objectId: blob.objectId,
            storageKey: blob.storageKey,
            sizeBytes: 0,
            sha256: '',
            reservationToken: crypto.randomUUID(),
            updatedAt: new Date(),
          });
          return Promise.resolve(claimOf(row));
        },

        confirmBlob(pending, confirmation) {
          return Promise.resolve().then(() => {
            assertCallerBlobKey(confirmation.blobKey);
            const row = pending.status === 'pending' ? current(pending) : null;
            if (row === null) return null;
            const previous = rows.get(idOf(row.sessionId, row.engine, confirmation.blobKey));
            const replaced = previous === undefined ? null : claimOf(aside(previous));
            remove(row);
            put({
              ...row,
              rowKey: confirmation.blobKey,
              status: 'ready',
              sizeBytes: confirmation.sizeBytes,
              sha256: confirmation.sha256,
              reservationToken: null,
              updatedAt: new Date(),
            });
            return { replaced };
          });
        },

        claimBlob(pending) {
          const row = pending.status === 'pending' ? current(pending) : null;
          return Promise.resolve(row === null ? null : claimOf(aside(row)));
        },

        forgetBlob(claim) {
          const row = current(claim);
          if (row !== null) remove(row);
          return Promise.resolve(row !== null);
        },

        unsettledBlobs(before) {
          return Promise.resolve(
            [...rows.values()]
              .filter(
                (row) =>
                  row.status === 'deleting' ||
                  (row.status === 'pending' && row.updatedAt.getTime() < before.getTime()),
              )
              .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
              .map(claimOf),
          );
        },

        getBlob(sessionId, engine, blobKey) {
          const row = rows.get(idOf(sessionId, engine, blobKey));
          return Promise.resolve(row?.status === 'ready' ? readable(row) : null);
        },

        listBlobs(sessionId) {
          return Promise.resolve(
            [...rows.values()]
              .filter((row) => row.sessionId === sessionId && row.status === 'ready')
              .sort((a, b) => a.rowKey.localeCompare(b.rowKey))
              .map(readable),
          );
        },

        referencedObjectIds(objectIds) {
          const held = new Set([...rows.values()].map((row) => row.objectId));
          return Promise.resolve(objectIds.filter((id) => held.has(id)));
        },

        purgeBefore(before) {
          const marked = [...rows.values()]
            .filter(
              (row) => row.status !== 'deleting' && row.updatedAt.getTime() < before.getTime(),
            )
            .map((row) => claimOf(aside(row)));
          return Promise.resolve({ streams: 0, entries: 0, blobs: marked, sessionIds: [] });
        },
      };
    },
  };
}
