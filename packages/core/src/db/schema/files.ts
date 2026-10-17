/**
 * `files` — the workspace file tree of spec §16 (§27).
 *
 * §16 is emphatic about what this is not: "Do not build RAG. Do not automatically create
 * embeddings. Do not create an indexing pipeline. Files are simply workspace files accessible
 * by the Claude Agent SDK's file tools." So this table is an index of a tree, not a document
 * store: the bytes live in the `ObjectStore` of §16 and this row says where.
 *
 * The columns come from §16's own list of what the UI must do — "upload, download, delete,
 * rename, folders, preview metadata":
 *
 *   * `path` is the whole tree. §16 draws it as `contracts/agreement.pdf`, so a folder is a
 *     prefix and a rename is an `UPDATE` of one column rather than a move of an object.
 *   * `kind` exists because "folders" is on that list and an empty folder has no file under it
 *     to imply it. A folder is a row; it just has no bytes.
 *   * `size_bytes` and `content_type` are §16's "preview metadata".
 *   * `storage_key` is the object's key in the `ObjectStore`. It is stored rather than derived
 *     from `path` precisely so that renaming a file does not have to rewrite an object — the
 *     two identifiers are allowed to diverge, and only this column knows the mapping.
 *
 * No checksum column: nothing in §16 or in the Wave 2 plan's acceptance for W2-CP-03
 * reads one, and a column nobody reads is a column that goes stale.
 */
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { memberships } from './memberships.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

/** A node in §16's tree is one of exactly two things. There is no third kind. */
export const fileKinds = ['file', 'folder'] as const;
export type FileKind = (typeof fileKinds)[number];

export const files = pgTable(
  'files',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * Workspace-relative path with `/` separators and no leading slash, e.g.
     * `contracts/agreement.pdf`. The CHECKs below are what make "inside this workspace" a
     * property of the row rather than a promise the API layer makes.
     */
    path: text('path').notNull(),
    kind: text('kind', { enum: fileKinds }).notNull(),
    /**
     * The `ObjectStore` key holding the bytes. NULL for a folder, which has none — and
     * NOT NULL for a file, which would otherwise be a row pointing at nothing.
     */
    storageKey: text('storage_key'),
    /** §16's "preview metadata". `bigint`, because object storage does not stop at 2 GiB. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    /** §16's "preview metadata": the MIME type recorded at upload. NULL when unknown. */
    contentType: text('content_type'),
    /**
     * Who created this row (issue #117). Tenant-paired below as `files_created_by_workspace_fk`.
     * See `agents.ts`'s `createdBy` comment for why the target is `memberships`, not `users`, and
     * for the backfill this column's migration performs on every existing row.
     */
    createdBy: uuid('created_by'),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One node per path per workspace, and the tenant index: `workspace_id` leads it, so
    // listing a workspace's tree is an index scan (§25).
    uniqueIndex('files_workspace_path_key').on(table.workspaceId, table.path),
    // The target `agent_files`' tenant-paired reference needs; see agents.ts for why this is a
    // table CONSTRAINT and not a unique INDEX.
    unique('files_id_workspace_key').on(table.id, table.workspaceId),
    index('files_workspace_owner_principal_idx').on(table.workspaceId, table.ownerPrincipalId),
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'files_created_by_workspace_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'files_owner_principal_workspace_fk',
    }),
    oneOf('files_kind_valid', table.kind, fileKinds),
    // Segments separated by single slashes, each segment non-empty and free of control
    // characters, with no leading or trailing slash.
    check('files_path_shape', sql`${table.path} ~ '^[^/[:cntrl:]]+(/[^/[:cntrl:]]+)*$'`),
    // `.` and `..` are how a path escapes its own workspace prefix. Rejected at the table, so
    // the rule holds for anything that reaches it by another route than the API.
    check('files_path_no_dot_segments', sql`${table.path} !~ '(^|/)[.][.]?(/|$)'`),
    // A file has bytes somewhere and a folder does not. Both directions, so neither can be
    // satisfied by leaving the column out.
    check(
      'files_storage_key_iff_file',
      sql`(${table.kind} = 'file') = (${table.storageKey} is not null)`,
    ),
    check(
      'files_storage_key_not_blank',
      sql`${table.storageKey} is null or length(btrim(${table.storageKey})) > 0`,
    ),
    check('files_size_non_negative', sql`${table.sizeBytes} >= 0`),
    // A folder occupies no bytes and has no MIME type. Without this a folder row could carry
    // metadata that a listing would render as though it described something.
    check(
      'files_folder_has_no_content',
      sql`${table.kind} <> 'folder' or (${table.sizeBytes} = 0 and ${table.contentType} is null)`,
    ),
  ],
);

export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
