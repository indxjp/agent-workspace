import { foreignKey, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

import { files } from './files.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

export const projectFiles = pgTable(
  'project_files',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    fileId: uuid('file_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.fileId] }),
    index('project_files_workspace_idx').on(table.workspaceId),
    foreignKey({
      columns: [table.projectId, table.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'project_files_project_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.fileId, table.workspaceId],
      foreignColumns: [files.id, files.workspaceId],
      name: 'project_files_file_workspace_fk',
    }).onDelete('cascade'),
  ],
);
