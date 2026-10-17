/**
 * The W2-CP-07 acceptance harness's own Vitest project.
 *
 * ## Why this file exists at all
 *
 * The harness must **not** be collected by `pnpm test`. It reaches a real model, so it can only run
 * where a credential exists, and this repository ships none on purpose (spec A.11, ADR-0021). The
 * obvious way to express that — `describe.skipIf(…)` in a `*.test.ts` — is refused by CI, and
 * rightly: the workflow's *"No test in the run was skipped"* step fails the job on any test that did
 * not execute, because *"a skipped test is not a passed test"*. A green run over an acceptance test
 * that never executed is exactly the failure mode this repository has written four ADRs about.
 *
 * `apps/web/server/runs/acceptance/` solved the same problem by being a `.mjs` **script** that
 * nothing collects. This harness cannot be one: it drives the real route handlers and the real
 * `FileTranscriptStore`, which are TypeScript under `apps/web`, and `apps/web` has no importable
 * build output. So it stays a Vitest file, is named `*.acceptance.ts` so the default
 * the default test-and-spec include never matches it, and is reached only by naming this config.
 *
 * ```sh
 * pnpm build
 * AW_SESSION_RESUME_ACCEPTANCE=1 npx vitest run --config apps/web/server/sessions/acceptance/vitest.config.mjs
 * ```
 *
 * The root `vitest.config.ts` lists `projects: ['apps/*', 'packages/*', 'tests']`, and a config
 * nested this deep is not a member of any of them — so `pnpm test` neither runs this suite nor
 * reports it as skipped. Verify that rather than believing it: `npx vitest list | grep acceptance`
 * prints nothing.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.acceptance.ts'],
    // Two real model round-trips, a process kill and a resume. The default 5 s would fail on the
    // first prompt; the per-test timeout in the file itself is the one that actually bounds it.
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
