/**
 * The `tests` project: every file under tests/ that no other `tests-*` project collects.
 *
 * The root `tests/` tree is split into Nx / Vitest projects (tests/projects.mjs lists them and
 * says why), each with its own `project.json` whose `test` target declares the paths it reads, so
 * `nx affected` runs a project only when one of them changed. `pnpm test-inputs:check`
 * (scripts/policy-check-test-inputs.mjs) proves the declarations cover what the files read.
 *
 * This project's files run in parallel. They used to run one at a time (`fileParallelism:
 * false`) because two of them start `next dev` against apps/web, and Next 16 refuses to be the
 * second dev server for a directory:
 *
 * ```text
 * ⨯ Another next dev server is already running.
 * ```
 *
 * Those two — `tests/auth.test.ts` and `tests/no-route-answers-503.test.ts` — are now the
 * `tests-next` project (tests/next/), which runs its two files one after the other and which Nx
 * runs with no other task beside it, so the serialisation is paid by two files rather than by
 * every file here.
 *
 * The project keeps the name `tests`, so `vitest run --project tests <file>` still selects what
 * it selected for every file left here.
 */
import { testsProjectConfig } from './vitest.shared.js';

export default testsProjectConfig('tests');
