import { and, asc, count, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';

import { files } from '../schema/files.js';
import { isSidePath } from '../side-paths.js';
import { clampCatalogPageLimit, type CatalogFile } from './resource-catalogs-model.js';
import type { CatalogPort } from './resource-catalogs-port.js';
import {
  fileColumns,
  logicalPath,
  pathUnderPrefix,
  type CatalogContext,
} from './resource-catalogs-sql.js';

export async function getFile(
  { db, workspaceId }: CatalogContext,
  path: string,
  options?: { readonly includePending?: boolean },
): Promise<CatalogFile | null> {
  if (isSidePath(path)) return null;
  const rows = await db
    .select(fileColumns)
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.path, path),
        options?.includePending === true
          ? inArray(files.status, ['pending', 'ready'])
          : eq(files.status, 'ready'),
      ),
    );
  return rows[0] ?? null;
}

export async function listFiles(
  { db, workspaceId }: CatalogContext,
  folder: string,
  page?: { readonly cursor?: string; readonly limit?: number },
): ReturnType<CatalogPort['list']> {
  const limit = clampCatalogPageLimit(page?.limit);
  const cursor = page?.cursor;
  // ponytail: ordering by `collate "C"` bypasses the path index, fine at catalog scale; it
  // makes the cursor agree with the in-memory catalog's code-point order.
  const found = await db
    .select(fileColumns)
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.status, 'ready'),
        folder === '' ? undefined : pathUnderPrefix(folder),
        cursor === undefined ? undefined : sql`${files.path} collate "C" > ${cursor}`,
      ),
    )
    .orderBy(sql`${files.path} collate "C"`)
    .limit(limit + 1);
  const rows = found.slice(0, limit);
  return { rows, cursor: found.length > limit ? (rows.at(-1)?.path ?? null) : null };
}

export async function countPendingFiles(
  { db, workspaceId }: CatalogContext,
  newerThan?: Date,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.status, 'pending'),
        ne(files.area, 'staging'),
        newerThan === undefined ? undefined : gte(files.updatedAt, newerThan),
      ),
    );
  return rows[0]?.value ?? 0;
}

export async function pendingFile(
  { db, workspaceId }: CatalogContext,
  path: string,
): Promise<CatalogFile | null> {
  const rows = await db
    .select(fileColumns)
    .from(files)
    .where(
      and(eq(files.workspaceId, workspaceId), eq(files.status, 'pending'), eq(logicalPath, path)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function stalePendingFiles(
  { db, workspaceId }: CatalogContext,
  olderThan: Date,
): Promise<readonly CatalogFile[]> {
  return db
    .select(fileColumns)
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.status, 'pending'),
        lt(files.updatedAt, olderThan),
      ),
    )
    .orderBy(asc(files.path));
}

export async function deletingFiles({
  db,
  workspaceId,
}: CatalogContext): Promise<readonly CatalogFile[]> {
  return db
    .select(fileColumns)
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.status, 'deleting')))
    .orderBy(asc(files.path));
}

export async function referencingFiles(
  { db, workspaceId }: CatalogContext,
  objectIds: readonly string[],
): Promise<readonly CatalogFile[]> {
  if (objectIds.length === 0) return [];
  return db
    .select(fileColumns)
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.kind, 'file'),
        inArray(files.objectId, [...objectIds]),
      ),
    )
    .orderBy(asc(files.path));
}
