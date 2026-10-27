/**
 * The tenant-scoped side of the `file_texts` cache (ADR-0147, P8-4).
 *
 * Three operations: list the files whose cached text is missing or stale, replace one file's text,
 * and run a lexical query over the cache. The repository never tokenises: callers hand it
 * `terms`, the space-separated words the application derived from a passage, and a ready-made
 * `to_tsquery` string. One module owns tokenisation (`apps/web/server/files/search-terms.ts`), so
 * the write side and the query side cannot disagree about where a Japanese word ends.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { FILE_TEXT_MAX_CHARS, fileTexts } from '../schema/file-texts.js';
import { files } from '../schema/files.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export { FILE_TEXT_MAX_CHARS };

/** The `files` row values a cached text was extracted from; a file differing from them is stale. */
export interface FileTextSource {
  readonly sizeBytes: number;
  /** `files.updated_at` as PostgreSQL prints it, so microseconds survive and compare equal. */
  readonly updatedAt: string;
}

/** A file whose cached text is missing or was extracted from an older version. */
export interface StaleFile extends FileTextSource {
  readonly id: string;
  readonly path: string;
  readonly storageKey: string;
  readonly contentType: string | null;
}

/** One searchable passage of a file. An empty `terms` stores a marker that matches nothing. */
export interface FileTextPassage {
  readonly page: number | null;
  readonly text: string;
  readonly terms: string;
}

export interface FileTextHit {
  readonly fileId: string;
  readonly path: string;
  readonly page: number | null;
  readonly text: string;
  readonly score: number;
}

export interface FileTextRepository {
  /**
   * Ready files (never folders or pending uploads) with no cached text for their current size and
   * `updated_at`, by path.
   */
  listStale(): Promise<readonly StaleFile[]>;
  /**
   * Replace every passage of one file in one transaction. `false` when the file no longer exists,
   * in which case nothing is written.
   */
  replace(
    fileId: string,
    source: FileTextSource,
    passages: readonly FileTextPassage[],
  ): Promise<boolean>;
  /**
   * Passages matching a `to_tsquery('simple', …)` string, best first. `allowedFileIds` narrows the
   * search to those files (`null` is the whole workspace); an empty list matches nothing.
   */
  search(
    tsquery: string,
    limit: number,
    allowedFileIds: readonly string[] | null,
  ): Promise<readonly FileTextHit[]>;
}

export interface FileTextRepositoryProvider {
  forScope(scope: WorkspaceScope): FileTextRepository;
}

export function createDatabaseFileTextRepositoryProvider(db: Database): FileTextRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'FileTextRepositoryProvider');
      return {
        async listStale() {
          const rows = await db
            .select({
              id: files.id,
              path: files.path,
              storageKey: files.storageKey,
              contentType: files.contentType,
              sizeBytes: files.sizeBytes,
              updatedAt: sql<string>`${files.updatedAt}::text`,
            })
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                eq(files.kind, 'file'),
                // Design §04: a pending upload's bytes are not there yet, so it is never cached.
                eq(files.status, 'ready'),
                sql`not exists (
                  select 1 from ${fileTexts}
                  where ${fileTexts.fileId} = ${files.id}
                    and ${fileTexts.workspaceId} = ${files.workspaceId}
                    and ${fileTexts.sourceSizeBytes} = ${files.sizeBytes}
                    and ${fileTexts.sourceUpdatedAt} = ${files.updatedAt}
                )`,
              ),
            )
            .orderBy(asc(files.path));
          return rows.flatMap((row) =>
            row.storageKey === null ? [] : [{ ...row, storageKey: row.storageKey }],
          );
        },
        async replace(fileId, source, passages) {
          return db.transaction(async (tx) => {
            // Lock the file row: serialises two searches extracting the same file, and a delete of
            // the file waits instead of failing this insert's foreign key.
            const locked = await tx
              .select({ id: files.id })
              .from(files)
              .where(and(eq(files.workspaceId, workspaceId), eq(files.id, fileId)))
              .for('update');
            if (locked.length === 0) return false;
            await tx
              .delete(fileTexts)
              .where(and(eq(fileTexts.workspaceId, workspaceId), eq(fileTexts.fileId, fileId)));
            if (passages.length > 0) {
              await tx.insert(fileTexts).values(
                passages.map((passage, ordinal) => ({
                  workspaceId,
                  fileId,
                  ordinal,
                  page: passage.page,
                  text: passage.text,
                  tsv: sql`to_tsvector('simple', ${passage.terms})`,
                  sourceSizeBytes: source.sizeBytes,
                  sourceUpdatedAt: source.updatedAt,
                })),
              );
            }
            return true;
          });
        },
        async search(tsquery, limit, allowedFileIds) {
          if (allowedFileIds !== null && allowedFileIds.length === 0) return [];
          const query = sql`to_tsquery('simple', ${tsquery})`;
          const score = sql<number>`ts_rank(${fileTexts.tsv}, ${query})::float8`;
          return db
            .select({
              fileId: fileTexts.fileId,
              path: files.path,
              page: fileTexts.page,
              text: fileTexts.text,
              score,
            })
            .from(fileTexts)
            .innerJoin(
              files,
              and(eq(files.id, fileTexts.fileId), eq(files.workspaceId, fileTexts.workspaceId)),
            )
            .where(
              and(
                eq(fileTexts.workspaceId, workspaceId),
                eq(files.status, 'ready'),
                sql`${fileTexts.tsv} @@ ${query}`,
                // One `uuid[]` parameter, not one per id, so no grant size can overflow the limit.
                allowedFileIds === null
                  ? undefined
                  : sql`${fileTexts.fileId} = ANY(${sql.param([...allowedFileIds])}::uuid[])`,
              ),
            )
            .orderBy(sql`${score} desc`, asc(files.path), asc(fileTexts.ordinal))
            .limit(limit);
        },
      };
    },
  };
}
