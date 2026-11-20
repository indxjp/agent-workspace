#!/usr/bin/env node
/**
 * `pnpm policy:check` — the inventories and registers agree with the tracked tree.
 *
 * Each `tests/**\/*.policy-check.ts` file is one policy over the committed tree: the route
 * inventory equals the declared subset of spec §34 and every route handler runs on Node; the screen
 * inventory declares every tracked mockup and page, agrees with ui/index.html and the plan, and
 * writes nothing; the RF-001 expected-failure register matches every `it.fails` owner; the
 * catalog-fake and duplicate-vocabulary allowlists equal what the scans find. They used to be
 * tests of the `tests` project, so they ran in every test lane that project reached, each file
 * loading the same scanners again in its own worker.
 *
 * Here they are one Vitest run of the `policy-check` lane (tests/static-checks/vitest.config.ts),
 * without isolation, so the files a worker runs share the scanners it has loaded (`git ls-files`,
 * the declaration and specification readers). It needs no build (packages resolve from `src`), so
 * it runs in check:fast and in CI's fast-checks. The readers' own unit tests stay in the `tests`
 * project.
 *
 *   pnpm policy:check              every policy
 *   pnpm policy:check <file>…      the policies whose file matches (Vitest filters)
 */
import process from 'node:process';

import { runStaticChecks } from '../tests/static-checks/run.mjs';

process.exitCode = runStaticChecks('policy-check', process.argv.slice(2), process.env);
