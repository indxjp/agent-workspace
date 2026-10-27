/**
 * `skill_revisions` — one published, immutable revision of a skill (SDK-19, N-1).
 *
 * The row is the index; the bytes are write-once objects under `skill-revisions/<name>/<number>/`
 * in the `ObjectStore`. Nothing rewrites those objects, so the table carries `created_at` and no
 * `updated_at`. `number` counts 1, 2, 3 per skill and is allocated under a lock on the skill row,
 * so two concurrent publishes never share one. A row is inserted `pending` when its number is
 * allocated and cleared once the revision's files are written; a pending row is never served.
 *
 * `agent_skills.revision` points at `(skill_id, workspace_id, number)`: an agent pins a revision
 * that exists, in its own workspace, or follows the skill's current content (`NULL`).
 */
import { boolean, check, foreignKey, integer, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { skills } from './skills.js';
import { workspaces } from './workspaces.js';

export const skillRevisions = pgTable(
  'skill_revisions',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `skill_revisions_skill_workspace_fk`; no reference of its own. */
    skillId: uuid('skill_id').notNull(),
    number: integer('number').notNull(),
    fileCount: integer('file_count').notNull(),
    /** The number is allocated but the files are not all written yet. */
    pending: boolean('pending').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    // The natural key, the tenant index (`workspace_id` leads it), and the target
    // `agent_skills` pins against.
    unique('skill_revisions_workspace_skill_number_key').on(
      table.workspaceId,
      table.skillId,
      table.number,
    ),
    foreignKey({
      columns: [table.skillId, table.workspaceId],
      foreignColumns: [skills.id, skills.workspaceId],
      name: 'skill_revisions_skill_workspace_fk',
    }).onDelete('cascade'),
    check('skill_revisions_number_positive', sql`${table.number} >= 1`),
    check('skill_revisions_file_count_positive', sql`${table.fileCount} >= 1`),
  ],
);

export type SkillRevisionRow = typeof skillRevisions.$inferSelect;
export type NewSkillRevisionRow = typeof skillRevisions.$inferInsert;
