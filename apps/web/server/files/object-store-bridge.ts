/**
 * The one place `apps/web/server/files/**` reaches `@agent-workspace/core/storage`.
 *
 * ## Why the re-export still exists after the subpath landed
 *
 * It was written as a *bridge* because `packages/core/package.json` had no `./storage` entry and
 * W2-CP-03 did not own that file, so every other module in this directory imported `ObjectStore`
 * through here and one relative `dist/`-path lived in one file rather than in eight. W2-INT-01 has
 * since added the subpath — ADR-0038 makes the shared manifest the integration level's, and
 * `docs/adr/W2-CP-03-s3-minio-backend-blocked.md` named this as the one file that changes when it
 * lands — so the specifier below is now the same shape `apps/web/server/agents/store.ts` uses for
 * `@agent-workspace/core/db`.
 *
 * The module is kept rather than deleted, and that is a choice with a reason: it is the single
 * seam at which `apps/web/server/files/**` selects an object-store backend. When W2-CP-03's
 * S3-compatible backend lands beside the local-filesystem one, this is the file whose export list
 * changes, and no route or handler moves.
 *
 * ## `dist/`, not `src/` — and why the exports map is written the way it is
 *
 * The subpath resolves `types` to `src/storage/index.ts` and `default` to
 * `dist/storage/index.js`, exactly as `./db` and `./secrets` do. That split is not cosmetic: an
 * earlier version of this file imported `src/` **directly**, by relative path, and two different
 * things broke, in this order:
 *
 *   1. **Turbopack could not resolve it at all.** `packages/core`'s own source uses NodeNext-style
 *      relative imports (`from './object-store.js'`, resolved by `tsc` to the sibling `.ts` file —
 *      correct for how that package is built and consumed via `@agent-workspace/core/db`), and
 *      Turbopack, asked to resolve that specifier as *bundler*-style straight off `apps/web`'s own
 *      module graph, looked for a literal `object-store.js` next to `object-store.ts` and found
 *      none: `next build` failed with `Module not found: Can't resolve './object-store.js'`,
 *      naming this file's import chain. `apps/web/tsconfig.json`'s own `moduleResolution:
 *      "bundler"` has no `.js`-means-`.ts` rule; that rule is `tsc`'s, for NodeNext, and only
 *      `packages/core`'s own build ever applied it.
 *   2. **Before that was fixed, importing the class this module now does not export at all** —
 *      `packages/core/src/storage/object-store.ts`'s header has the full story — silently produced
 *      two different runtime instantiations of `@agent-workspace/core/db`'s `WorkspaceScope`, one
 *      compiled from `src/` for this bridge and one loaded from `dist/` for every other import of
 *      it, and a scope minted by one was refused by the other's `#private`-field brand check.
 *      Pointing this bridge at the same `dist/` tree everything else already resolves to would
 *      also have fixed that half on its own, which is *why* `default` is `dist/` even though
 *      `object-store.ts` no longer needs a `WorkspaceScope` at all: one build artifact, one set of
 *      class identities, for every consumer.
 *
 * The consequence: **`packages/core` must be built before `apps/web` is typechecked, linted or
 * built** — which the wave protocol already requires ("pnpm build BEFORE pnpm test / pnpm lint")
 * and which `apps/web/package.json`'s own `build`/`dev` scripts already enforce
 * (`pnpm --filter @agent-workspace/core build && next build`). `pnpm typecheck` at the repository
 * root runs `pnpm -r typecheck` with no cross-package ordering, so a typecheck-only invocation of
 * `apps/web` without a prior `pnpm build` will fail to resolve this import — the same ordering
 * requirement the protocol already states, made concrete here rather than assumed.
 */
export {
  createAzureBlobObjectStoreProviderFromConfig,
  createGcsObjectStoreProviderFromConfig,
  createLocalFilesystemObjectStoreProvider,
  createS3ObjectStoreProvider,
  createS3ObjectStoreProviderFromConfig,
  ensureS3Bucket,
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectStore,
  type ObjectStoreProvider,
  type PutObjectInput,
} from '@agent-workspace/core/storage';
