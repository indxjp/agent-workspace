/**
 * `workspace_features` — the features a workspace has switched off (ADR-0160 D6).
 *
 * A row means "off": a workspace that never touched its switches has no rows and every installed
 * feature is on, so adding a feature to `FEATURE_IDS` needs no backfill. `feature` is restated
 * from the contract's list by a CHECK, the same way every closed set in this schema is.
 */
import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

export const workspaceFeatures = pgTable(
  'workspace_features',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    feature: text('feature', { enum: FEATURE_IDS }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('workspace_features_workspace_feature_key').on(table.workspaceId, table.feature),
    oneOf('workspace_features_feature_valid', table.feature, FEATURE_IDS),
  ],
);

export type WorkspaceFeatureRow = typeof workspaceFeatures.$inferSelect;
export type NewWorkspaceFeatureRow = typeof workspaceFeatures.$inferInsert;
