/**
 * The `tests` project runs its files **one at a time**, because two of them start a Next.js server.
 *
 * `tests/auth.test.ts` spawns `next dev` to prove that a running server refuses every `/api/**`
 * request without a session, and `tests/no-route-answers-503.test.ts` spawns one to prove that
 * every declared route reaches a handler. Vitest runs test *files* in parallel workers, and
 * Next 16 refuses to be the second dev server for a directory — measured, not inferred:
 *
 * ```text
 * ⨯ Another next dev server is already running.
 * - Local:        http://127.0.0.1:54502
 * - PID:          25536
 * - Dir:          …/apps/web
 * ```
 *
 * whereupon the second suite waited out its whole start-up timeout and reported a server that
 * "did not answer". Both suites pass alone and one of them fails whenever they are collected
 * together, which is a scheduling accident rather than a fact about the code — exactly the failure
 * `packages/core/src/db/repositories/testing.ts`'s header describes for a shared database, one
 * resource down.
 *
 * `fileParallelism: false` is the narrowest fix available: it serialises **this project's** files
 * and leaves every `apps/*` and `packages/*` project running in parallel as before, so the cost is
 * paid only by the six files that share one Next.js application. The alternative — a lock, a
 * retry, or a longer timeout — would make the second server wait for a resource Next has already
 * refused to give it twice.
 *
 * This file also fixes the project's name, which the root `vitest.config.ts` previously derived
 * from the directory. Adding a config here would otherwise rename the project and change what
 * `--project tests` selects.
 */
import { configDefaults, defineConfig } from 'vitest/config';

import rootConfig from '../vitest.config.js';

const rootAlias = rootConfig.resolve?.alias;
if (!Array.isArray(rootAlias)) {
  throw new Error('vitest.config.ts: the root resolve.alias must be an array');
}

export default defineConfig({
  // A project does not inherit the root aliases. These two packages are read from `src`, because
  // `tests/platform-matrix.test.ts` runs in `pnpm docs:check` before any package is built; the
  // rest keep resolving through `node_modules`, as they always did here.
  resolve: {
    alias: rootAlias.filter(({ find }) =>
      /@indx-workspace\\?\/(contracts|platforms)/u.test(String(find)),
    ),
  },
  test: {
    name: 'tests',
    fileParallelism: false,
    exclude: [...configDefaults.exclude, 'browser/**'],
  },
});
