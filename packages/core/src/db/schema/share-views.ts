import { foreignKey, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId } from './columns.js';
import { shares } from './shares.js';
import { workspaces } from './workspaces.js';

export const shareViews = pgTable(
  'share_views',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    shareId: uuid('share_id').notNull(),
    visitorKey: text('visitor_key'),
    createdAt: createdAt(),
  },
  (table) => [
    index('share_views_workspace_share_created_idx').on(
      table.workspaceId,
      table.shareId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.shareId, table.workspaceId],
      foreignColumns: [shares.id, shares.workspaceId],
      name: 'share_views_share_workspace_fk',
    }).onDelete('cascade'),
  ],
);
