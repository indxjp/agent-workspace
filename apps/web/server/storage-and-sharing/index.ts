/**
 * The storage and sharing context's public entry (refactoring plan part 04, step 7).
 *
 * Code in another context imports files, shares, storage, storage connections and surfaces from
 * here, not from the folders underneath. `pnpm architecture:check` enforces it: the
 * `context-storage-and-sharing-entered-through-its-entry` rule in dependency-cruiser.config.mjs
 * refuses a new deep import, and the deep imports that were left when the rule landed are in
 * .dependency-cruiser-known-violations.json, where they can only shrink. Tests, `composition/` and
 * the context's own modules keep importing the modules directly.
 *
 * Every type other contexts use is re-exported with `export type`, which loads nothing at run time.
 * Values are re-exported only from modules without start-up work: importing this file loads no
 * application context, no database driver, no object-store or cloud SDK, nothing Next.js-only and no
 * downstream context. These deep value imports stay, on purpose, and are in the baseline:
 *
 *   * `storage/objects.ts` (`readWhole`, `readBytes`, `listAll`, `streamToBytes`,
 *     `ObjectConflictError`, `storageRefusalClass`, …), used by skills, sessions, platforms, run
 *     write-back and fixtures: it loads the S3, Azure and Google Cloud object-store SDKs.
 *   * `storage/service.ts` (`createStorageService`) and `storage/testing.ts`
 *     (`openRootObjectStore`), used by fixtures: they load the object-store SDKs and the database
 *     driver.
 *   * `storage/store.ts` (`listCatalogFiles`): it loads the database driver.
 *   * `files/handlers.ts`, `files/http.ts` and `files/search-http.ts` (`isUnderSessionPrefix`,
 *     `toResponse`, the file-search handlers): each loads about 330 modules, including the
 *     object-store SDKs, the database driver and the agents context.
 *
 * No storage and sharing module imports this file: that would be a cycle, and
 * `no-circular-dependencies` refuses it.
 */
export { encodeFileId } from '../files/file-id';
export { narrowFileGrants } from '../files/search-terms';
export { isUnderAllowedPrefix } from '../storage-connections/prefixes';
export type { StorageContext, StorageService } from '../storage/service';
export type {
  ResourceCatalogStoreProvider,
  SkillObjectEntry,
  SkillObjects,
  WorkspaceSkillsStoreProvider,
} from '../storage/store';
