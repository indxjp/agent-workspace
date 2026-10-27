/**
 * The areas an object can live in (the storage design, §04 "Where files live"). A dependency-free
 * leaf, so the `files` table's CHECK can read it at schema load without loading the storage
 * barrel. It lives under `storage/` rather than `db/` because the `./storage` subpath publishes it,
 * and the database layer must not be reachable through any other subpath.
 */
export const storageAreas = ['files', 'skills', 'session-state', 'artifacts', 'staging'] as const;
export type StorageArea = (typeof storageAreas)[number];
