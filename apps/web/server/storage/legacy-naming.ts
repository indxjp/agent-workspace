/**
 * The old object naming (the storage design, §04): an object sits at `<area prefix>/<workspace
 * id>/<catalog path>`, with no object id. Pure, no IO: `migrate-naming.ts` lists and adopts.
 */
import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EMPTY_FOLDER_MARKER = '.agent-workspace-empty-folder';
const RUN_STAGING_ARCHIVE = /^runs\/[^/]+\/outputs\/\.runtime-staging\.tar$/u;

export interface LegacyObject {
  readonly workspaceId: string;
  readonly path: string;
}

/**
 * Read the workspace and catalog path out of a listed `key` under `prefix` (no trailing slash), or
 * `null` for a key that is not a file the catalog should hold: another layout, a stray directory, an
 * empty-folder marker, a run's staging archive, or a path no route could name (`toObjectKey` refuses
 * an empty, `.` or `..` segment and a side path).
 */
// storage-bridge(#1699): old object naming
export function parseLegacyKey(prefix: string, key: string): LegacyObject | null {
  if (!key.startsWith(`${prefix}/`)) return null;
  const relative = key.slice(prefix.length + 1);
  const cut = relative.indexOf('/');
  if (cut < 1) return null;
  const workspaceId = relative.slice(0, cut);
  const path = relative.slice(cut + 1);
  if (!WORKSPACE_ID.test(workspaceId) || path === '') return null;
  if (path.split('/').at(-1) === EMPTY_FOLDER_MARKER || RUN_STAGING_ARCHIVE.test(path)) return null;
  try {
    toObjectKey(path);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return null;
    throw error;
  }
  return { workspaceId, path };
}
