import { and, eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { runtimeVerifications } from '../schema/runtime-verifications.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

interface RuntimeVerificationRecord {
  readonly configurationKey: string;
  readonly fingerprint: string;
  readonly verifiedAt: Date;
  readonly expiresAt: Date;
}

/** The last passing Test Runtime of each driver, for one workspace. */
interface RuntimeVerificationRepository {
  /** The driver's recorded pass, or `null`. Expiry and key are the caller's to judge. */
  get(driverId: string): Promise<RuntimeVerificationRecord | null>;
  /** Record a pass, replacing the driver's earlier one. */
  record(driverId: string, verification: RuntimeVerificationRecord): Promise<void>;
}

export interface RuntimeVerificationRepositoryProvider {
  forScope(scope: WorkspaceScope): RuntimeVerificationRepository;
}

export function createDatabaseRuntimeVerificationRepositoryProvider(
  db: Database,
): RuntimeVerificationRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'RuntimeVerificationRepositoryProvider');
      return {
        async get(driverId) {
          const rows = await db
            .select({
              configurationKey: runtimeVerifications.configurationKey,
              fingerprint: runtimeVerifications.fingerprint,
              verifiedAt: runtimeVerifications.verifiedAt,
              expiresAt: runtimeVerifications.expiresAt,
            })
            .from(runtimeVerifications)
            .where(
              and(
                eq(runtimeVerifications.workspaceId, checked.workspaceId),
                eq(runtimeVerifications.driverId, driverId),
              ),
            )
            .limit(1);
          return rows[0] ?? null;
        },

        async record(driverId, verification) {
          await db
            .insert(runtimeVerifications)
            .values({ workspaceId: checked.workspaceId, driverId, ...verification })
            .onConflictDoUpdate({
              target: [runtimeVerifications.workspaceId, runtimeVerifications.driverId],
              set: verification,
            });
        },
      };
    },
  };
}
