import { and, eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { surfaceSessionKeys } from '../schema/surface-session-keys.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

interface RecordSurfaceSessionKeyInput {
  readonly sessionId: string;
  readonly surfaceName: string;
  readonly agentId: string;
  /** The SHA-256 hex digest of the resume key; the key itself is never stored. */
  readonly keyHash: string;
}

interface SurfaceSessionKeyRecord {
  readonly sessionId: string;
  readonly surfaceName: string;
  readonly agentId: string;
  readonly keyHash: string;
}

/** A hosted surface session's resume key, for one workspace (issue #538, C18). */
export interface SurfaceSessionKeyRepository {
  /** Record a session's key. A session has one key; a second record is refused by the pk. */
  record(input: RecordSurfaceSessionKeyInput): Promise<void>;
  /** The key row of `sessionId` in this workspace, or `null`. */
  find(sessionId: string): Promise<SurfaceSessionKeyRecord | null>;
}

export interface SurfaceSessionKeyRepositoryProvider {
  forScope(scope: WorkspaceScope): SurfaceSessionKeyRepository;
}

export function createDatabaseSurfaceSessionKeyRepositoryProvider(
  db: Database,
): SurfaceSessionKeyRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'SurfaceSessionKeyRepositoryProvider');
      return {
        async record(input) {
          await db.insert(surfaceSessionKeys).values({
            sessionId: input.sessionId,
            workspaceId: checked.workspaceId,
            surfaceName: input.surfaceName,
            agentId: input.agentId,
            keyHash: input.keyHash,
          });
        },

        async find(sessionId) {
          const rows = await db
            .select({
              sessionId: surfaceSessionKeys.sessionId,
              surfaceName: surfaceSessionKeys.surfaceName,
              agentId: surfaceSessionKeys.agentId,
              keyHash: surfaceSessionKeys.keyHash,
            })
            .from(surfaceSessionKeys)
            .where(
              and(
                eq(surfaceSessionKeys.workspaceId, checked.workspaceId),
                eq(surfaceSessionKeys.sessionId, sessionId),
              ),
            )
            .limit(1);
          return rows[0] ?? null;
        },
      };
    },
  };
}
