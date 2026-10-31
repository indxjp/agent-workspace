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
 * The storage design, §04 adds three more columns. `object_id` is the permanent ID the object is
 * stored under; every file has one and a folder has none. `area` says where the object lives, and
 * `sha256` is its checksum (NULL until a writer records one).
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
import { SIDE_PATH_ROOT } from '../side-paths.js';
import { storageAreas } from '../../storage/storage-areas.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

/** A node in §16's tree is one of exactly two things. There is no third kind. */
export const fileKinds = ['file', 'folder'] as const;
export type FileKind = (typeof fileKinds)[number];

/**
 * Storage design §04 "File states": a signed-link upload reserves a `pending` row before its bytes
 * exist and becomes `ready` once they do. Only `ready` rows appear in lists, search and grants.
 * `deleting` marks a row whose object is being removed.
 */
export const fileStatuses = ['pending', 'ready', 'deleting'] as const;
export type FileStatus = (typeof fileStatuses)[number];

/**
 * How a pending upload is written: `relay` through the server's own `save`, `signed` by the client
 * to a signed link. A same-owner re-reserve refreshes a pending row of the same mode only, so a
 * relay save never resets a signed upload's declared size and a mint never signs a save's object.
 * NULL for a ready row written before the column and for a row no upload owns (a staging row).
 */
export const uploadModes = ['relay', 'signed'] as const;
export type UploadMode = (typeof uploadModes)[number];

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
    /** Defaults to `ready`, so every row written by a one-step write is immediately visible. */
    status: text('status', { enum: fileStatuses }).notNull().default('ready'),
    /** The permanent ID the object is stored under. NULL exactly for a folder, which has no object. */
    objectId: uuid('object_id'),
    /**
     * The real path a side-path row stands for (see `side-paths.ts`): set exactly when `path` is a
     * side path, so a pending replacement or a removed row never occupies the path of a ready row.
     */
    targetPath: text('target_path'),
    area: text('area', { enum: storageAreas }).notNull().default('files'),
    /** Lower-case hex SHA-256 of the bytes; NULL until a writer records it. */
    sha256: text('sha256'),
    uploadMode: text('upload_mode', { enum: uploadModes }),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One node per path per workspace, and the tenant index: `workspace_id` leads it, so
    // listing a workspace's tree is an index scan (§25).
    // Only a ready row, or a pending upload to a free path, holds its real path; every other row
    // waits at a side path. Writers still `ON CONFLICT (workspace_id, path)`, so this key stays.
    uniqueIndex('files_workspace_path_key').on(table.workspaceId, table.path),
    // One pending row per logical path has no index: every writer takes the path lock first
    // (`lockForWrite`) and `reserve` refuses a path that already has a pending row.
    // At most one row per stored object; rows with no object id yet are outside the index.
    uniqueIndex('files_workspace_object_key')
      .on(table.workspaceId, table.objectId)
      .where(sql`${table.objectId} is not null`),
    // The target `agent_files`' tenant-paired reference needs; see agents.ts for why this is a
    // table CONSTRAINT and not a unique INDEX.
    unique('files_id_workspace_key').on(table.id, table.workspaceId),
    index('files_workspace_owner_principal_idx').on(table.workspaceId, table.ownerPrincipalId),
    // Every reserve counts the workspace's pending uploads (`countPending`, newest first by
    // `updated_at`); a pending row is short-lived, so the index stays small.
    index('files_workspace_pending_updated_idx')
      .on(table.workspaceId, table.updatedAt)
      .where(sql`${table.status} = 'pending'`),
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
    oneOf('files_status_valid', table.status, fileStatuses),
    oneOf('files_area_valid', table.area, storageAreas),
    check(
      'files_upload_mode_valid',
      sql`${table.uploadMode} is null or ${table.uploadMode} in ('relay', 'signed')`,
    ),
    // `target_path` is set exactly when the path is a side path, and a side row is never ready, so
    // it can never be listed, searched or granted.
    check(
      'files_side_path_target',
      sql`(${table.targetPath} is not null) = (split_part(${table.path}, '/', 1) = ${sql.raw(`'${SIDE_PATH_ROOT}'`)}) and (${table.targetPath} is null or ${table.status} <> 'ready')`,
    ),
    check('files_sha256_shape', sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`),
    // A folder has no bytes to wait for, so it is never reserved.
    check('files_folder_is_ready', sql`${table.kind} <> 'folder' or ${table.status} = 'ready'`),
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
    // The storage design, §06: the upgrade guard proved the move off the old naming, so a file is
    // read only by its object id.
    check(
      'files_file_has_object_id',
      sql`${table.kind} <> 'file' or ${table.objectId} is not null`,
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
