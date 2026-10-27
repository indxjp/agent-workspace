/**
 * `file_texts` — the cache of text a search request extracted from a file (ADR-0147, P8-4).
 *
 * ADR-0147 allows one narrow exception to §16's "Do not create an indexing pipeline": text that a
 * caller asked for, stored with its `tsvector` so the next search is a lexical PostgreSQL query.
 * Nothing writes this table on upload; `GET /api/files/search` extracts the files that are missing
 * or stale, within a budget, and caches the result here. This is a cache, not a store of record:
 * every row can be dropped and rebuilt from `files` and the object store.
 *
 * One row is one searchable passage of at most `FILE_TEXT_MAX_CHARS` characters, so its `tsvector`
 * stays far below PostgreSQL's 1 MB limit: a PDF page or workbook sheet (`page` is its 1-based
 * ordinal, repeated when a long page is split) or a stretch of a document without pages (`page`
 * NULL). `ordinal` numbers the passages of a file from 0 and is what is unique. A file whose
 * extraction was refused (encrypted, unsupported, over a limit) gets one marker row with empty
 * text. It matches nothing and records that this version of the file was already tried, so the
 * next search does not retry it.
 *
 * Staleness: `source_size_bytes` and `source_updated_at` are the `files` row's values at extraction
 * time. A file whose current values differ is stale and is re-extracted; deleting a file, or its
 * workspace, deletes its text through the tenant-paired cascade. A rename is an `UPDATE` of
 * `files.path`, so the row id and this text survive it and search reads the current path by join.
 *
 * Japanese: PostgreSQL's parser does not segment Japanese and no extension is assumed (Cloud SQL
 * and Azure Flexible Server do not all offer `pg_bigm`). The application therefore writes `tsv`
 * from pre-tokenised terms (NFKC, then overlapping character bigrams for Han, Hiragana and
 * Katakana runs) on the `simple` configuration, and builds the query the same way. The repository
 * computes `tsv`, never a trigger, so the tokenisation has one owner.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId } from './columns.js';
import { files } from './files.js';
import { workspaces } from './workspaces.js';

/** PostgreSQL's `tsvector`, read and written as its text form; queries use `to_tsquery`. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** The most characters one passage may hold; longer text is split into several passages. */
export const FILE_TEXT_MAX_CHARS = 20_000;

export const fileTexts = pgTable(
  'file_texts',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `file_texts_file_workspace_fk`. */
    fileId: uuid('file_id').notNull(),
    /** Position of this passage within its file, from 0. */
    ordinal: integer('ordinal').notNull(),
    /** PDF page or workbook sheet ordinal, 1-based; NULL for a format without pages and for a marker. */
    page: integer('page'),
    text: text('text').notNull(),
    tsv: tsvector('tsv').notNull(),
    sourceSizeBytes: bigint('source_size_bytes', { mode: 'number' }).notNull(),
    /** Kept as text so the database's microseconds survive the round trip and compare equal. */
    sourceUpdatedAt: timestamp('source_updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('file_texts_file_ordinal_key').on(table.fileId, table.ordinal),
    index('file_texts_workspace_file_idx').on(table.workspaceId, table.fileId),
    index('file_texts_tsv_idx').using('gin', table.tsv),
    foreignKey({
      columns: [table.fileId, table.workspaceId],
      foreignColumns: [files.id, files.workspaceId],
      name: 'file_texts_file_workspace_fk',
    }).onDelete('cascade'),
    check('file_texts_ordinal_non_negative', sql`${table.ordinal} >= 0`),
    check('file_texts_page_positive', sql`${table.page} is null or ${table.page} >= 1`),
    check(
      'file_texts_text_length',
      sql`char_length(${table.text}) <= ${sql.raw(String(FILE_TEXT_MAX_CHARS))}`,
    ),
    check('file_texts_source_size_non_negative', sql`${table.sourceSizeBytes} >= 0`),
  ],
);

export type FileTextRow = typeof fileTexts.$inferSelect;
