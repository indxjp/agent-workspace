/**
 * `@agent-workspace/core/db-model` — the values of the database layer that need no database.
 *
 * Every name here is also on the public `@agent-workspace/core/db` surface and is re-exported, not
 * redeclared: the errors a store names, the limits a caller enforces too, and the pure readings of
 * a stored row. What this subpath leaves out is everything that reaches PostgreSQL: the client, the
 * schema, drizzle and the repositories.
 *
 * It exists for load cost, not for access. `@agent-workspace/core/db` evaluates the whole
 * repository layer and its schema (some 300 modules and drizzle) the moment anything is imported
 * from it, so a web module that needed only `UnknownWorkspaceError` or `SESSION_STATE_PAGE_LIMIT`
 * made every test that reached it load the database layer as well. A module that needs a database
 * still imports `@agent-workspace/core/db` and obtains one through `openDatabaseRoot()`.
 *
 * The database-reachability gate classifies this subpath: it is not a `./db` key, so it may expose
 * only names the public `./db` subpath exposes (`database-reachability-surfaces.test-support.ts`).
 * `db-model.test.ts` holds the other half: nothing this module loads reaches drizzle, `pg` or the
 * schema.
 */
export { FILE_TEXT_MAX_CHARS, SESSION_STATE_PAGE_LIMIT } from './db/limits.js';
export {
  appliedRuntimeProfileId,
  bodyDeclaresSubagents,
  bodyHasDescription,
  bodySubagentNames,
} from './db/repositories/agent-versions-body.js';
export {
  narrowFileGrants,
  narrowStorageGrants,
  resolveFromRows,
  storageGrantChange,
} from './db/repositories/agent-versions-resolution.js';
export { LOCAL_RUNTIME_API_KEY_NAME_PREFIX } from './db/repositories/directory/local-runtime-key-name.js';
export { isProjectArchived } from './db/repositories/project-archive.js';
export {
  CatalogPathPendingError,
  CatalogPathTakenError,
  parsePendingSkillDelete,
} from './db/repositories/resource-catalogs-model.js';
export { listCatalogFiles } from './db/repositories/resource-catalogs-port.js';
export { UnknownWorkspaceError } from './db/repositories/unknown-workspace.js';
