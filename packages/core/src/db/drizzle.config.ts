/**
 * `drizzle-kit` configuration — author-time only.
 *
 * **Why it is here and not at the repository root.** R-15 sketched `drizzle.config.ts` at the
 * root next to `migrations/`. The root of the repository is not this task's to write (§2.3
 * file ownership), and putting the config beside the schema it points at turns out to be the
 * better arrangement anyway: the schema, the config that diffs it, the migrator that applies
 * the result and the seed that fills it are one directory, and a reader who opens
 * `packages/core/src/db` sees the whole database story. Paths below are therefore relative to
 * `packages/core`, which is where `pnpm --filter @agent-workspace/core run db:generate` runs.
 *
 * **What this config does NOT carry.** No `dbCredentials`: `drizzle-kit generate` diffs
 * TypeScript against the last snapshot and never connects. The commands that would need
 * credentials — `push`, `studio`, `drizzle-kit migrate` — are not used by this project.
 * Deploy-time migration is `migrate.ts`, which R-15 §3 established is the runtime migrator
 * from `drizzle-orm/node-postgres/migrator`, needing neither `drizzle-kit` nor esbuild nor
 * TypeScript in the runtime image.
 *
 * **Casing.** `casing` is not set, deliberately. Every column in `schema/` states its own
 * snake_case name, so there is no inference to configure and no way for a rename in TypeScript
 * to silently rename a database column.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  // Spec §29 places `migrations/` at the repository root.
  out: '../../migrations',
  // `--> statement-breakpoint` between statements, so the migrator runs them one at a time.
  breakpoints: true,
  // Zero-padded sequence prefix: `0000_…`, `0001_…`. Sorting a directory listing and sorting
  // the apply order are then the same operation.
  migrations: { prefix: 'index' },
});
