# W1-CORE-01 — The SDK surface gate reads `sdk.d.ts`; it does not import the SDK

Status: accepted
Date: 2026-09-03
Decided by: W1-CORE-01 (Schema/Core)
Scope: `tests/sdk-surface.test.ts`, `vitest.config.ts`, `tsconfig.root.json`, `tests/tsconfig.json`,
`apps/runner/package.json`, `pnpm-lock.yaml`

## Context

Two rules given to this task point in opposite directions.

- **Spec §42 / plan §9.1**: `apps/runner/src/claude.ts` is the *only* file in the repository that may
  import `@anthropic-ai/claude-agent-sdk`. Plan §9.1 lists a `no-sdk-import` test among the per-PR
  gates and §6.3's Wave 1 task table assigns that test to W1-RN-01. **It does not exist yet**, and
  it is not this task's to write; on this branch §42 is a rule held by construction and review, not
  a gate. This ADR is about not making it harder to enforce once W1-RN-01 lands.
- **This task's acceptance line**: `tests/sdk-surface.test.ts` must assert the **installed** SDK's
  option names and types against research note R-01.

A test that does `import type { Options } from '@anthropic-ai/claude-agent-sdk'` satisfies the second
and puts a second import site in the tree. Whether a type-only import "counts" then becomes an
argument about how the §42 gate is implemented — and a gate whose scope is arguable is a gate that
will eventually be argued down.

There is a third fact that resolves it. `R-01-options.json` was not written by hand: R-01 committed
`docs/research/fixtures/agent-sdk/extract-options.mjs`, which reads every `Options` member and the
`query()` signature **out of `sdk.d.ts` as text**. The artefact is a text-derived contract, so the
gate that checks it can be text-derived too.

## Decision

**1. The gate reads files; it never imports, requires or executes the SDK.** `tests/sdk-surface.test.ts`
reads `sdk.d.ts`, `sdk.mjs` and `package.json` from the installed package directory with `fs`. A
`no-sdk-import` gate of any shape — grep, AST, or module-graph — will therefore still be able to
pass over this repository when W1-RN-01 writes one, and §42 keeps meaning what it says.

**2. The strongest assertion available is used: re-run the committed generator and compare bytes.**
Rather than writing a second parser that could drift from the first, the test executes
`extract-options.mjs` in a temporary directory with `SDK_DTS`/`SDK_PKG` pointed at the installed
package, and requires its output to be byte-identical to the committed `R-01-options.json`. That is
the reproduction procedure `docs/research/fixtures/agent-sdk/README.md` documents, executed by CI
instead of by hand. On a mismatch the artefact is wrong, not the generator.

**3. The gate fails when it cannot run.** If no `sdk.d.ts` is found under `apps/runner/node_modules`
or the root, the test throws with the paths it tried. It does not skip. ADR-0015: a check that
cannot run fails, and a green run over a gate that never loaded is the same bug.

**4. `packages/core` is checked against the SDK through data, not types.** `compiledSdkOptionKeys`
lists every key the compile step can emit; the gate asserts each is a real, optional `Options` key
in both the artefact and the shipped `.d.ts`. A compile-time proof in `types.ts`
(`COMPILED_SDK_OPTION_KEYS_ARE_EXHAUSTIVE`) makes a key added to the type but not to that array a
compile error, so the list cannot silently stop covering the type.

## Files touched outside this task's `Owns` globs

All four exist so that the gate above is real rather than nominal. Each is declared in the pull
request's Ownership section.

| File | Why it could not be avoided |
| --- | --- |
| `apps/runner/package.json` | The gate asserts the **installed** SDK, so the SDK has to be a dependency. §42 puts it in `apps/runner` — the only importer — and the licence register in `scripts/check-licenses.mjs` already carries an exception for it scoped `prod`, which a devDependency would not match. Added as an exact pin, `0.3.258`, no range, per R-01 §1. |
| `pnpm-lock.yaml` | The direct output of installing that dependency. [ADR-0009](0009-pnpm-lock-ownership-exception.md) assigns the lockfile to a wave's **first** task and tells a later one to escalate. W1-DB-01 is this stack's first task and is already frozen as this branch's base, so escalating would stall the wave on a file nobody can now edit at the point ADR-0009 intends. Declared instead, which is the visibility ADR-0009's rule exists to produce. |
| `vitest.config.ts` | `projects` was `['apps/*', 'packages/*']`. `tests/` matches neither, so `tests/sdk-surface.test.ts` was collected by nothing. This was verified before the change: a deliberately failing probe at `tests/__probe.test.ts` left `pnpm test` green. One entry, `'tests'`, added. |
| `tsconfig.root.json`, `tests/tsconfig.json` | `tests/` is inside no workspace member, so `pnpm -r typecheck` never sees it; `tests/**/*.ts` in the root config fixes that. Type-aware ESLint's `projectService` searches for the nearest `tsconfig.json` and would otherwise fail the file outright, which `tests/tsconfig.json` fixes. Both were observed failing before being added. |
| `packages/core/src/{schemas,config}.test.ts` | Tests for files this task owns, colocated the way every other test in the repository is (`client.test.ts`, `seed.test.ts`, `one-of.test.ts`). Named in the `Owns` line as an extension of the source files, not as new territory. |

## Alternatives considered

- **`import type { Options }` in the test.** Rejected: it makes §42's scope arguable, which is worse
  than the small amount of text-matching the chosen approach costs.
- **Re-implement the `Options` parser inside the test.** Rejected: two parsers drift, and the one in
  the test would be the one nobody re-reads. R-01's README already says the generator is authoritative.
- **Put the test inside `packages/core` so no config changes are needed.** Rejected: this task's own
  card in plan §6.3 ("`tests/sdk-surface.test.ts` green against the pinned SDK") and the §9.1 gate
  list both name that path, and the gate asserts a contract that belongs to no
  single package. Moving it to dodge a two-line config change would misplace it permanently.
- **Skip the test when the SDK is absent.** Rejected under ADR-0015 — that is the failure-open shape
  this programme has already shipped three times.
- **Add the SDK as a root devDependency instead.** Rejected: the licence exception for
  `@anthropic-ai/claude-agent-sdk` is scoped `prod`, and an exception whose scope does not match the
  run does not clear the package — `node scripts/check-licenses.mjs --dev` would fail.

## Consequences

- W1-RN-01 inherits the SDK dependency already pinned and locked, and should not add it again. If it
  needs a *different* version, that is a change to this pin and an amendment to R-01.
- CI now installs the SDK on every run: eight platform packages are in the lockfile, roughly 90
  additional packages resolved. `pnpm install --frozen-lockfile` and both licence runs were executed
  against this tree and pass.
- The gate is version-brittle by design. An SDK bump fails it until `R-01-options.json` is
  regenerated and the diff is read — which is the review step the pin exists to force.
- Nothing here executes the SDK. The evidence produced is `verified (type contract)` for `sdk.d.ts`
  and `documented` for `sdk.mjs`, in R-01's legend. It is not a probe, and this task's PR says so.
