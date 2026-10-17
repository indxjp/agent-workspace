/**
 * The one place `apps/web/server/skills/**` reaches `@agent-workspace/core/storage`.
 *
 * Mirrors `apps/web/server/files/object-store-bridge.ts` deliberately, down to the comment: that
 * file's header explains why the subpath resolves `types` to `src/storage/index.ts` and `default`
 * to `dist/storage/index.js`, and why `packages/core` must therefore be built before `apps/web` is
 * typechecked, linted or built — the same is true here, and this task does not re-litigate it.
 *
 * This module is a separate file from the files task's bridge rather than an import of it — a
 * relative import across `apps/web/server/files/**` and `apps/web/server/skills/**` would couple
 * two tasks with pairwise-disjoint `Owns` globs through a file neither declares, and either task's
 * later, independent edit to its own bridge would move the other's import target out from under
 * it. `@agent-workspace/core/storage` already exists on `main` (added by W2-INT-01), so this task
 * adds no dependency and no `exports` subpath — see `docs/adr/W2-CP-04-skill-storage-keys.md`.
 */
export {
  createAzureBlobObjectStoreProviderFromConfig,
  createGcsObjectStoreProviderFromConfig,
  createLocalFilesystemObjectStoreProvider,
  createS3ObjectStoreProviderFromConfig,
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectStore,
  type ObjectStoreProvider,
  type PutObjectInput,
} from '@agent-workspace/core/storage';
