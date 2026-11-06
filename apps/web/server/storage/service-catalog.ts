import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage';
import { isPathPending, isPathTaken, type CatalogPort } from './store';
import type { StorageOperations } from './service-operations';
import type { StorageService } from './service-contract';
import { listedIn } from './service-policy';

export function serviceCatalog(
  operations: StorageOperations,
): Pick<StorageService, 'createFolder' | 'list' | 'get' | 'rename' | 'remove'> {
  const { deps, audit, removePending, discard } = operations;
  return {
    // @story US-STO-01
    async createFolder(ctx, path) {
      let key: string;
      try {
        key = toObjectKey(path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const made = await catalog.createFolder(key, {
        ownerPrincipalId: ctx.principalId,
        createdBy: ctx.userId,
      });
      if (made.kind === 'created') return { ok: true, row: made.row };
      return {
        ok: false,
        code: made.row.status === 'pending' ? 'upload_in_progress' : 'name_conflict',
      };
    },

    // @story US-STO-01
    async list(ctx, area, folder, page) {
      const catalog = await deps.catalog(ctx.workspaceId);
      // ponytail: the catalog pages across areas, so this page may hold fewer than `limit` rows;
      // the cursor is still right. Page by area in the catalog if callers need full pages.
      const found = await catalog.list(folder, page);
      return {
        rows: found.rows.filter((row) => row.kind === 'file' && listedIn(row, area)),
        cursor: found.cursor,
      };
    },

    async get(ctx, area, path) {
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.get(path);
      return row !== null && row.kind === 'file' && listedIn(row, area) ? row : null;
    },

    // @story US-STO-03
    async rename(ctx, area, from, to) {
      let source: string;
      let target: string;
      try {
        source = toObjectKey(from);
        target = toObjectKey(to);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.get(source);
      if (row !== null && row.kind === 'file' && !listedIn(row, area)) {
        return { ok: false, code: 'not_found' };
      }
      let moved: Awaited<ReturnType<CatalogPort['rename']>>;
      try {
        moved = await catalog.rename(source, target);
      } catch (error) {
        if (isPathPending(error)) return { ok: false, code: 'upload_in_progress' };
        if (isPathTaken(error)) return { ok: false, code: 'path_taken' };
        throw error;
      }
      if (moved.rows === 0) return { ok: false, code: 'not_found' };
      if (row !== null && area === 'files') {
        await audit(ctx, 'file-moved', row, { occurrence: null, label: `${source} -> ${target}` });
      }
      return { ok: true, moved: moved.files };
    },

    // @story US-STO-04
    async remove(ctx, area, path, { recursive }) {
      let target: string;
      try {
        target = toObjectKey(path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.get(target);
      if (row === null) return removePending(ctx, catalog, area, target);
      if (row.kind === 'file' && !listedIn(row, area)) return { ok: false, code: 'not_found' };
      // ponytail: a file added under the folder between this check and `remove` goes with it.
      if (row.kind === 'folder' && !recursive) {
        const inside = await catalog.list(target, { limit: 2 });
        if (inside.rows.length > 1) return { ok: false, code: 'not_empty' };
      }
      const marked = await catalog.remove(target);
      for (let at = 0; at < marked.length; at += 16) {
        await Promise.all(
          marked.slice(at, at + 16).map((r) => discard(catalog, ctx.workspaceId, r)),
        );
      }
      // Nothing marked: a concurrent delete won the race, and it audits its own delete.
      if (area === 'files' && marked.length > 0) {
        await audit(ctx, 'file-deleted', row, { occurrence: row.id, label: target });
      }
      const removedFiles = marked
        .filter((r) => r.kind === 'file')
        .map((r) => r.targetPath ?? r.path)
        .sort();
      return { ok: true, removed: marked.length, files: removedFiles };
    },
  };
}
