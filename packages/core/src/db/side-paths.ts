/**
 * Side paths (the storage design, §04). Only a `ready` row occupies its real catalog path: a
 * pending replacement of a ready file, and a row that was removed or replaced, wait at a side path
 * and keep the path they stand for in `target_path`. A leaf module, like `storage-areas.ts`: the
 * `files` table's CHECK reads it at schema load.
 *
 * The root begins with a bare `%`, which `toObjectKey` refuses as malformed percent-encoding, so no
 * route can name a side path; `files_path_shape` still accepts it.
 */
export const SIDE_PATH_ROOT = '%aside';

export const sidePath = (rowId: string): string => `${SIDE_PATH_ROOT}/${rowId}`;

export const isSidePath = (path: string): boolean => path.split('/', 1)[0] === SIDE_PATH_ROOT;
