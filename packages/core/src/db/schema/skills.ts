/**
 * `skills` — one Claude Agent SDK skill (spec §7, §27).
 *
 * §7 is unusually prescriptive about the *format* and says nothing about the columns: "Do not
 * invent a proprietary skill format", "A skill should ultimately be represented as
 * `.claude/skills/<name>/SKILL.md` plus optional supporting files", and "The stored
 * representation should stay compatible with Claude's native `SKILL.md` structure".
 *
 * So this table stores the skill's **identity** and its `SKILL.md` **verbatim**, and nothing
 * that is derived from either:
 *
 *   * `name` is the directory name in `.claude/skills/<name>/`, which is why it is
 *     slug-shaped and unique per workspace rather than free text.
 *   * `skill_md` is the byte content of `SKILL.md`. §7's "Description", "Instructions" and
 *     "Allowed Tools" all live inside it — as YAML front matter and body — and are NOT
 *     separate columns. A `description` column would be a copy of a value that also exists in
 *     `skill_md`, and no constraint could keep the two in agreement; W1-DB-01 decision 6 draws
 *     that line ("a denormalised copy is acceptable when a constraint enforces it and not
 *     otherwise"). Storing the file verbatim is also what makes W2-CP-04's byte-identical
 *     export possible for `SKILL.md` without a serialiser that has to reproduce the author's
 *     own front-matter formatting.
 *   * `enabled` is §7's "enable/disable it". It is platform state, not skill content, so it is
 *     a column rather than something written into the file.
 *
 * **Supporting files are not rows here.** They are objects in the `ObjectStore` of §16 —
 * the Wave 2 plan names that dependency edge explicitly (W2-CP-04 → W2-CP-03) — and
 * `ObjectStore.list()` enumerates them, so a `skill_files` table would be a second index of
 * the same directory that could disagree with it. §27 names no such table either.
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { memberships } from './memberships.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

export const skills = pgTable(
  'skills',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The `.claude/skills/<name>/` directory name. Unique within the workspace. */
    name: text('name').notNull(),
    /** `SKILL.md`, byte for byte. Front matter and body; nothing here parses it. */
    skillMd: text('skill_md').notNull(),
    /** §7's "enable/disable it". A disabled skill is not materialised into a runtime. */
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Who created this row (issue #117). Tenant-paired below as `skills_created_by_workspace_fk`.
     * See `agents.ts`'s `createdBy` comment for why the target is `memberships`, not `users`, and
     * for the backfill this column's migration performs on every existing row.
     */
    createdBy: uuid('created_by'),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    /**
     * The platform record about the skill (name, enabled flag, timestamps). A row of an earlier
     * release has it only as a `skill-meta/<name>.json` object until it is read and copied here.
     */
    meta: jsonb('meta'),
    /**
     * Set once a delete has passed its in-use check and is removing the skill's bytes: the owner and
     * the published revision numbers, so a retry by the owner clears every `.skills/<name>@<n>/`
     * folder. The row stays until the delete finishes; null for a live skill.
     */
    pendingDelete: jsonb('pending_delete'),
    /** The digest of the built-in release installed into the row; null for a skill the user made. */
    builtinDigest: text('builtin_digest'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('skills_workspace_name_key').on(table.workspaceId, table.name),
    // The target `agent_skills`' tenant-paired reference needs; see agents.ts for why this is
    // a table CONSTRAINT and not a unique INDEX.
    unique('skills_id_workspace_key').on(table.id, table.workspaceId),
    index('skills_owner_principal_idx').on(table.ownerPrincipalId),
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'skills_created_by_workspace_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'skills_owner_principal_workspace_fk',
    }),
    // The name becomes a directory name on a filesystem inside the sandbox. A name that is not
    // a slug is a name that will be escaped, or not escaped, somewhere later.
    check('skills_name_shape', sql`${table.name} ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'`),
    // An empty SKILL.md is not a skill; §7 requires the file to exist in the exported directory.
    check('skills_skill_md_not_blank', sql`length(btrim(${table.skillMd})) > 0`),
  ],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
