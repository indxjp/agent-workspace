# W1-RN-01 — `apps/runner` reaches `@agent-workspace/core` through its built `dist/`, so its typecheck builds it first

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-01 (Runner)
Scope: `apps/runner/package.json`, `pnpm-lock.yaml`

## Context

`apps/runner/src/claude.ts` has to import from `packages/core`: the compile step of spec §5
(`compileRunRequest`), the event classifier W1-CORE-01 defined (`classifySdkEvent`), the request
schema (`RunRequest`) and the tenant scope validator. That is the task — the boundary translates
*the object `packages/core` produces* and normalises into *the union `packages/core` defines*.
Restating either here would be a second copy of the thing §42 exists to keep singular.

`packages/core`'s `exports` map points at `./dist/index.d.ts` and `./dist/index.js`. Nothing in
`.github/workflows/ci.yml` builds anything before it type-checks, so with the dependency declared
and `dist/` absent, `tsc -p apps/runner/tsconfig.json` fails with `TS2307: Cannot find module
'@agent-workspace/core'` — measured on this branch, not assumed. Three of the obvious repairs are
outside this task's ownership globs: TypeScript project references, a `paths` mapping in
`apps/runner/tsconfig.json`, and a `development` export condition in `packages/core/package.json`.
`pnpm install` does not run a workspace project's `prepare` script either — also measured, with
`pnpm install --force` on a fully-installed tree, which ran no build.

## Decision

`apps/runner`'s `typecheck` script builds its workspace dependency first:

```json
"typecheck": "pnpm --filter @agent-workspace/core run build && tsc -p tsconfig.json"
```

`build` needs no such change: `pnpm -r build` already walks the workspace in topological order, and
`apps/runner` now genuinely depends on `@agent-workspace/core`, so core is built before the runner
either way. `pnpm -r typecheck` walks the same order, which is why the runner's typecheck is the
last one to run and why the build it triggers is a no-op on a tree that was already built.

The dependency is declared as `"@agent-workspace/core": "workspace:*"`. Its only trace in
`pnpm-lock.yaml` is three lines under `importers: apps/runner:` recording a `link:` to
`../../packages/core`. Nothing is downloaded, nothing is version-resolved, and the licence surface
`scripts/check-licenses.mjs` inspects is unchanged.

## On ADR-0009, and how ADR-0017 settled it

Verification round 1 raised this as an ownership finding, and it was a fair one against the rule as
it then stood. [ADR-0009](0009-pnpm-lock-ownership-exception.md) gave `pnpm-lock.yaml` to a wave's
**first** task and told a later one that discovered it needed a dependency to *escalate*. This is
task 3 of 4 in the Wave 1 stack. The first version of this record argued a narrow reading — that
the rule's purpose is to prevent *parallel* edits, and this branch is stacked strictly on top of the
tasks below it — and offered the remedy of dropping the three lines. That was an argument about a
rule, made by the task the rule constrained, which is the weakest place to make one.

**ADR-0017 amends ADR-0009 and removes the question.** A manifest belongs to its package; the
lockfile is generated. `apps/runner/package.json` is this task's file, this task changed it, and the
rule is therefore: regenerate `pnpm-lock.yaml` and declare it in the PR body's Ownership section.
Both are done. The regenerated result is the same three lines under `importers: apps/runner:` —
`pnpm install` reproduces them exactly, which is what "generated" means here — and `pnpm install
--frozen-lockfile` passes on the branch.

ADR-0017 also settles the conflict procedure, which this branch then exercised: rebasing onto
`aw/w1-02b-deps` brought W1-DEP-01's own three lockfile lines for `apps/web`, and the two edits
merged because they are separate `importers:` entries. Had they collided, the fix would have been
to re-run `pnpm install`, never to hand-merge.

What does **not** change: the licence surface `scripts/check-licenses.mjs` inspects. The entry is a
`link:` to a workspace package. No registry fetch, no version resolution, nothing new in
`node_modules`.

## Alternatives considered

- **Import `packages/core` by relative path** (`../../../packages/core/src/index.js`). Rejected: it
  is outside `apps/runner`'s `rootDir`, so `pnpm build` fails with TS6059. `tests/sdk-surface.test.ts`
  does exactly this, and can, because `tests/` emits nothing.
- **Restate the types locally in `claude.ts`.** Rejected as the worst option available: two copies
  of the §5 option shape and of the event union, drifting silently, which is precisely the class of
  defect W1-CORE-01's surface test was written to prevent.
- **Take `classifySdkEvent` as an injected dependency** so the boundary needs no import. Rejected as
  contrivance — it moves the same import one caller upwards and buys nothing.
- **Add a build step to CI before typecheck.** Rejected: `.github/workflows/ci.yml` is not this
  task's file, and a change there affects every gate rather than the one member that needs it.
- **Point core's `exports` at `src/` under a `development` condition.** The tidy fix, and outside
  this task's ownership. Named here so the next task that owns `packages/core/package.json` or the
  root tsconfigs can take it.

## The honest downside

`pnpm lint` run on a fresh clone **before** `pnpm typecheck` will fail on `apps/runner/src/claude.ts`
with `@typescript-eslint/no-unsafe-*`, because type-aware linting sees the unresolved import as
`any`. CI runs typecheck first, so the ordering holds there, but it is an ordering dependency
between two scripts that reads as independent, and nothing enforces it. A developer who runs lint
first gets a confusing error whose real cause is a missing `dist/`.

Secondly, a `typecheck` script that builds another package is a lie about what the word means, and
it will be copied by the next app that depends on core unless the tidy fix lands first. That is why
the tidy fix is named above rather than left as folklore.
