/**
 * The features one workspace has switched off (ADR-0160 D6): a row means "off", no row means on.
 * Reads and writes are by the whole set, so a caller never races two partial edits.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { and, eq, notInArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { workspaceFeatures } from '../schema/workspace-features.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface WorkspaceFeatureRepository {
  /** The features this workspace has switched off, in `FEATURE_IDS` order. */
  listDisabled(): Promise<readonly FeatureId[]>;
  /**
   * Make `disabled` exactly the switched-off set, in one transaction. Answers the set as it was
   * just before this replace (read under the same lock, so no concurrent replace falls between the
   * read and the write) and the set it leaves, both in `FEATURE_IDS` order.
   */
  replaceDisabled(disabled: readonly FeatureId[]): Promise<{
    readonly before: readonly FeatureId[];
    readonly after: readonly FeatureId[];
  }>;
}

export interface WorkspaceFeatureRepositoryProvider {
  forScope(scope: WorkspaceScope): WorkspaceFeatureRepository;
}

const inContractOrder = (found: ReadonlySet<FeatureId>): FeatureId[] =>
  FEATURE_IDS.filter((id) => found.has(id));

export function createDatabaseWorkspaceFeatureRepositoryProvider(
  db: Database,
): WorkspaceFeatureRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'WorkspaceFeatureRepositoryProvider');
      return {
        async listDisabled() {
          const rows = await db
            .select({ feature: workspaceFeatures.feature })
            .from(workspaceFeatures)
            .where(eq(workspaceFeatures.workspaceId, workspaceId));
          return inContractOrder(new Set(rows.map((row) => row.feature)));
        },
        async replaceDisabled(disabled) {
          const wanted = inContractOrder(new Set(disabled));
          const before = await db.transaction(async (tx) => {
            // Serialise replaces of one workspace: under READ COMMITTED two concurrent
            // delete-then-insert passes would otherwise leave the union of both sets.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-features:${workspaceId}`}, 0))`,
            );
            // Read after the lock: a replace that committed while this one waited is in `before`.
            const current = await tx
              .select({ feature: workspaceFeatures.feature })
              .from(workspaceFeatures)
              .where(eq(workspaceFeatures.workspaceId, workspaceId));
            await tx.delete(workspaceFeatures).where(
              and(
                eq(workspaceFeatures.workspaceId, workspaceId),
                // `notInArray` over an empty list is a SQL error, so an empty set deletes by id alone.
                wanted.length === 0 ? undefined : notInArray(workspaceFeatures.feature, wanted),
              ),
            );
            if (wanted.length > 0) {
              await tx
                .insert(workspaceFeatures)
                .values(wanted.map((feature) => ({ workspaceId, feature })))
                .onConflictDoNothing();
            }
            return inContractOrder(new Set(current.map((row) => row.feature)));
          });
          return { before, after: wanted };
        },
      };
    },
  };
}
