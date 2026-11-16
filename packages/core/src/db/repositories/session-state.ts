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
 *   * `reserveBlob` / `confirmBlob` / `getBlob` metadata — an ACP agent's state directory,
 *     snapshotted.
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
import type { Database } from '../client.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { createSessionStateBlobs } from './session-state/blobs.js';
import { createSessionStatePurge } from './session-state/purge.js';
import { scopedSessionState } from './session-state/scoped.js';
import { createSessionStateStreams } from './session-state/streams.js';
import type { SessionStateRepository } from './session-state/types.js';

export { assertCallerBlobKey, blobSideKey } from './session-state/sql.js';
export { SESSION_STATE_PAGE_LIMIT } from './session-state/streams.js';
export type {
  SessionStateBlobClaim,
  SessionStateBlobConfirmation,
  SessionStateBlobRepository,
  SessionStateEntryInput,
  SessionStateRepository,
  SessionStateStreamKey,
  StoredSessionStateBlob,
  StoredSessionStateEntry,
  StoredSessionStateStream,
} from './session-state/types.js';

export interface SessionStateRepositoryProvider {
  forScope(scope: WorkspaceScope): SessionStateRepository;
}

export function createDatabaseSessionStateRepositoryProvider(
  db: Database,
): SessionStateRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'SessionStateRepositoryProvider');
      const scoped = scopedSessionState(checked.workspaceId);
      return {
        ...createSessionStateStreams(db, scoped),
        ...createSessionStateBlobs(db, scoped),
        ...createSessionStatePurge(db, scoped),
      };
    },
  };
}
