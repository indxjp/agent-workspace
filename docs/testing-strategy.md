# Testing strategy

Where a test goes, what CI enforces, and how to run it. The rules in
[ENGINEERING_GUIDELINES.md](../ENGINEERING_GUIDELINES.md#tests) apply; this page is the map.

## Where a test goes

| You are changing                                                         | Write                                                                      | Lives in                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A parser, path rule, cursor, redaction, state machine                    | A unit test, plus a fast-check property test when the input space is large | Beside the code: `*.test.ts`, `*.property.test.ts`                              |
| A use case or route                                                      | A unit test on the in-memory store                                         | Beside the code                                                                 |
| A store port (`memory-store.ts` and its PostgreSQL adapter)              | A `describe<Port>Conformance` suite run against both implementations       | The port's `store.test.ts`, for example `apps/web/server/agents/store.test.ts`  |
| SQL, constraints, tenancy                                                | The conformance suite's PostgreSQL leg                                     | Gated by `TEST_DATABASE_URL`, which `pnpm test` provides                        |
| `packages/contracts`, the SDK, the CLI, OpenAPI                          | Contract tests; generated references stay current                          | `tests/`, `packages/*/src`; `pnpm docs:check`                                   |
| An engine, platform or runtime adapter                                   | The shared conformance kit                                                 | `packages/engine/src/testing/conformance.ts`, `tests/engine`, `tests/platforms` |
| A concept the Lean model covers                                          | Update the model and regenerate its vectors                                | `formal/`, `tests/formal`, `pnpm formal:check`                                  |
| Something only a browser shows (CSP, cookies, hydration, keyboard, a11y) | A Playwright spec                                                          | `tests/browser/*.spec.mjs`                                                      |
| A shell block or claim in the docs                                       | Mark it so the docs-claims runner executes it                              | `tests/docs-claims`                                                             |
| The developer journey (install, first agent, deploy)                     | The journey harness                                                        | `tests/journey`                                                                 |

Prefer the lowest layer that can fail for the reason you care about. A browser test is for what
jsdom cannot show.

## The layers

- **Unit.** Vitest, beside the code. Test behavior and contracts, not call order.
- **Store conformance.** Every store with a `memory-store.ts` exports one `describe<Port>Conformance`
  suite and calls it for the in-memory store and for the PostgreSQL adapter, so the fake and the
  real thing cannot drift. `tests/store-conformance.test.ts` fails when a memory store has no suite;
  the stores that do not yet are listed in `tests/fitness/store-conformance-allowlist.json`, which
  may only shrink. Do not add a store to it; write the suite.
- **Property tests.** fast-check for invariants over all inputs, for example
  `packages/core/src/telemetry/redact.property.test.ts`,
  `packages/engine/src/path-grant.property.test.ts` and `packages/sdk/src/events/sse.property.test.ts`.
- **Characterization.** `it.fails` / `test.fails` is only for a registered refactoring
  characterization: the title names one `RF-###` owner from the register in
  `docs/architecture/refactoring/claude-agent-workspace-refactoring-decisions.md`, enforced by
  `tests/refactoring-characterization-register.test.ts`.
- **Formal.** A Lean specification in `formal/` whose generated vectors are replayed by
  `tests/formal`. `pnpm formal:check` builds it, audits for `sorry` and extra axioms, checks layer
  direction and that the generated catalogue and vectors are current. It needs the Lean toolchain;
  CI runs it when a diff reaches the model.
- **Browser.** Playwright (`pnpm test:browser`), Chromium, against the built web app and a migrated,
  seeded database.
- **Docs claims.** `node tests/docs-claims/run.mjs` runs the shell blocks the docs mark as claims.
- **Developer journey.** `node tests/journey/run.mjs` (and `--first-hour`) drives install to a
  running agent. The live-credential workflows (`journey-live`, `providers-live`, `live-e2e`) are
  separate from the PR gate.

## What CI enforces

`CI success` (`.github/workflows/ci.yml`, job `ci-success`) is the required check. It fails unless
every job it needs succeeded: `fast-checks`, `build`, `build-embedded`, `typecheck-lint`,
`heavy-checks` (the test shards), `release-checks`, `release-images`, `formal`, `image-scan`,
`generated-project-e2e`, `journey-e2e`, `docs-claims`, `tool-sandbox-e2e`, `coverage`, `browser`.

Gates that keep tests honest:

- **No skipped test.** `scripts/ci/vitest-no-skip.mjs` reads every Vitest JSON report and fails on
  any test that neither passed nor failed, or on a run with no tests.
  `scripts/ci/playwright-no-skip.mjs` does the same for Playwright and also fails on a test that
  passed only on retry (flaky).
- **Coverage floors.** The `coverage` job runs three suites (critical packages, apps, ui-cli)
  against the thresholds in `vitest.coverage.config.ts`, `vitest.apps.coverage.config.ts` and
  `vitest.ui-cli.coverage.config.ts`. Floors only rise.
- **Ratchets that only shrink.** `eslint-suppressions.json` (`scripts/check-lint-baseline.mjs`),
  `.dependency-cruiser-known-violations.json`, `tests/fitness/*.json`, and the complexity ceiling
  (`pnpm complexity:check` requires the ceiling to equal the measured maximum).
- **Supply chain.** gitleaks secret scan and osv-scanner dependency scan in `fast-checks`.
- **Generated files are current.** `pnpm docs:check` covers the SDK reference, OpenAPI, `llms.txt`
  and the platform matrix. Regenerate with `pnpm docs:generate`, never by hand.

`pnpm check:fast` runs the static gates locally; `pnpm check:ci` adds the three coverage suites.

## Running locally

```sh
pnpm test                                   # builds, starts PostgreSQL 18 and an S3 server, runs Vitest
pnpm exec vitest run path/to/file.test.ts   # one file; needs the services pnpm test would start
pnpm test:coverage                          # a coverage suite (also test:coverage:apps, :ui-cli)
pnpm test:browser                           # Playwright; build the web app, migrate and seed first
pnpm formal:check                           # Lean model and vectors
pnpm check:fast && pnpm test && pnpm build  # the finish line for every change
```

`pnpm test` (`scripts/test-with-services.mjs`) uses `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` when
set, otherwise Docker (`postgres:18-alpine`, SeaweedFS), otherwise a native fallback (ADR-0066).
Without a Docker daemon, the four suites that drive real containers skip locally by design; CI runs
them, so a local skip is not evidence.

## Rules

1. For a bug, the first commit is the failing regression test. For a new seam, the contract (schema
   or port) and its conformance test come before the implementation.
2. Never skip, disable or retry a test to get green. An unavailable prerequisite fails explicitly in
   CI. No fixed sleeps: await a signal or inject a clock.
3. Never grow a baseline, allowlist or ceiling, add a suppression, or lower a coverage floor.
4. Boundary schemas need valid, invalid, unknown-key, missing-field and numeric-bound cases.
5. Coverage locates untested risk; it is not a reason to add assertion-free tests.
6. Report which checks ran with counts, and which did not run and why.
