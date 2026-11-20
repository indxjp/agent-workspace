# oxlint in front of ESLint: evaluation (2026-11-19)

Unit C2 of the CI speed programme asked whether [oxlint](https://oxc.rs/docs/guide/usage/linter)
(type-aware where stable) can run the lint rules it supports in front of ESLint, with ESLint keeping
only the rules oxlint lacks and running with `--cache --cache-strategy content`, without losing any
rule coverage. **Verdict: not adopted.** Nothing in the lint pipeline changed; this page is the
record, so the question is not re-asked without new facts.

## Verdict in one paragraph

Lint time is spent in the 23 type-aware `@typescript-eslint` rules, not in the syntactic ones.
Moving every syntactic rule oxlint supports out of ESLint cut ESLint's CPU time on `apps/web` (the
critical path) by 6–17 %, which is inside the wall-clock noise of the shared host, and the migrated
configuration does not reproduce today's verdicts (659 findings on a tree ESLint passes, see below). The only large
gain is type-aware oxlint (`oxlint-tsgolint`), about 10× faster on the full tree, but it type-checks
with TypeScript 7 (typescript-go), and the owner decision for this programme is that **lint stays on
TypeScript 6** (decision D5). `eslint --cache` is unsafe for type-aware rules and was measured to
miss a cross-file regression, so it is not added to a gate either.

## Measurements

Host: shared 20-core Linux development host (other agents running, so wall times vary by about
±25 %; CPU time is the steadier figure). Versions: ESLint 10.14.0, typescript-eslint 8.72.1,
TypeScript 6.0.2, oxlint 1.90.0, oxlint-tsgolint 7.0.2005 (both older than 14 days), Nx 24.0.3.
Workspace builds were done first; lint ran with `--skip-nx-cache`.

| Run                                                                                                      |                    Wall |      CPU (user) | Notes                                                               |
| -------------------------------------------------------------------------------------------------------- | ----------------------: | --------------: | ------------------------------------------------------------------- |
| `nx run-many -t lint --excludeTaskDependencies --parallel=4 --skip-nx-cache` (CI's command, 24 projects) |                 332.8 s |         416.6 s | critical path `@agent-workspace/web:lint` 4 m 31 s; peak RSS 4.1 GB |
| `eslint apps/web` (today's config), three runs                                                           | 156.1 / 177.5 / 223.1 s | 132.1 / 134.1 s | the 223 s run had `TIMING` and `--stats` on (CPU not recorded)      |
| `eslint apps/web` with the 87 oxlint-covered rules off ("residual" ESLint), two runs                     |         130.5 / 184.9 s | 110.7 / 124.7 s | −6 % to −17 % CPU; wall within noise                                |
| `oxlint .` with the migrated syntactic rules                                                             |             0.38–0.42 s |       0.6–0.9 s | whole tree                                                          |
| `oxlint --type-aware .` with the migrated syntactic and type-aware rules                                 |                  31.4 s |          59.9 s | whole tree, peak RSS 5.6 GB                                         |
| `oxlint --type-aware apps packages tests scripts examples/store/catalog`                                 |                  21.4 s |          56.0 s | ESLint's scope                                                      |

Where ESLint's time goes on `apps/web` (`TIMING=40`; the first type-aware rule to touch a file also
pays for the type checker, so the top row includes it):

| Rule                                               |   Time |  Share |
| -------------------------------------------------- | -----: | -----: |
| `@typescript-eslint/no-unnecessary-type-assertion` | 40.6 s | 26.9 % |
| `@typescript-eslint/no-misused-promises`           | 29.2 s | 19.4 % |
| `@typescript-eslint/no-floating-promises`          | 22.7 s | 15.1 % |
| `@typescript-eslint/no-unsafe-assignment`          | 18.1 s | 12.0 % |
| `@typescript-eslint/no-unsafe-return`              |  7.4 s |  4.9 % |
| `@typescript-eslint/no-unsafe-argument`            |  6.8 s |  4.5 % |
| all other type-aware rules                         |  ~16 s |  ~10 % |
| every syntactic rule together                      |  ~10 s |   ~7 % |

The rule time adds up to about 151 s; the rest of each run is parsing and building the TypeScript
program, which the residual ESLint still has to do for its type-aware rules.

## Why the syntactic split is not worth adopting

1. **The gain is too small to see.** About 7 % of rule time is syntactic. Measured: 6–17 % less
   CPU on the critical-path project, and no wall-clock change that rises above run-to-run noise.
2. **The migrated configuration changes verdicts.** Today's tree is ESLint-clean. With the config
   produced by `@oxlint/migrate@1.90.0`, `oxlint .` reports 659 findings:
   - 602 come from file-scoped blocks whose `ignores` cannot be expressed in an oxlint `overrides`
     entry (the migrator warns "ignore list inside overrides is not supported"): 537
     `no-restricted-properties`, 51 `no-console`, 14 `no-restricted-globals`, firing in tests and
     composition roots that the ESLint config deliberately exempts. Reproducing those exemptions
     would mean restructuring every scoped block by hand.
   - 57 are differences in rule implementations (39 `no-unsafe-optional-chaining`, 11
     `no-useless-escape`, 3 `no-regex-spaces`, 2 `no-unused-vars`, 1 each `no-control-regex` and
     `preserve-caught-error`; some of them in files ESLint does not lint).
     Accepting them would mean code changes or rule options unrelated to speed.
3. **The baselines stay in ESLint.** `eslint-suppressions.json` baselines `no-restricted-properties`
   (18) and `no-restricted-syntax` (16). oxlint has no suppressions file, and adding inline
   suppressions is forbidden, so both rules would stay in ESLint whatever else moved.
   `no-restricted-syntax` is not implemented in oxlint at all (custom AST selectors).
4. **Two tools, one verdict.** Every rule moved means a second config to keep in step, with no
   measurable saving to pay for it.

## Why type-aware oxlint is not adopted

Type-aware oxlint is the only option with a large gain (31 s for the whole tree against 333 s for
CI's lint command; 21 s for ESLint's scope). Inside ESLint's scope it agreed closely: two extra
findings (`unbound-method` in
`packages/core/src/db/repositories/database-reachability-resolution.test-support.ts`,
`no-unnecessary-type-assertion` in `packages/cli/src/deployment-docker.ts`), and it caught a
deliberately planted cross-file floating promise exactly as ESLint did. Outside that scope (the
`examples/*` apps and `infra/cloudflare`, which ESLint does not lint) it reported about 2,570
findings, mostly `no-unsafe-*` on `error`-typed values.

It is not adopted because `oxlint-tsgolint` runs the rules on the TypeScript 7 checker, and the
programme's owner decision D5 keeps lint on TypeScript 6 (typecheck may move to `tsgo` only with a
zero diagnostic difference on every project). The suppressions-file gap in point 3 above applies
here too. Revisit only if D5 is reopened for lint; the adoption bar would then be the same as D5's:
zero diagnostic difference on every linted file, every scoped `ignores` reproduced, and the two
baselined rules kept in ESLint.

## Why `eslint --cache --cache-strategy content` is not added

ESLint's cache keys a file's result on that file's content and the config only. A type-aware rule's
result also depends on the files it imports, so a cached "clean" survives a change elsewhere that
makes it wrong. Measured with two scratch files in `packages/run-protocol/src`: `b.ts` calls
`work()` from `a.ts`; lint with the cache (clean); change `work` in `a.ts` to return a `Promise`;
lint again with the cache: **exit 0**; lint without the cache: **exit 1**,
`@typescript-eslint/no-floating-promises` in `b.ts`. A gate that misses that is weaker than
today's. The Nx task cache already replays lint safely at project granularity (its hash covers the
project's and its dependencies' inputs plus `lintConfig`, see `nx.json`).

## How to reproduce

```sh
# baseline (after `pnpm nx run-many -t build`)
pnpm nx run-many -t lint --excludeTaskDependencies --parallel=4 --output-style=static --skip-nx-cache
TIMING=40 pnpm exec eslint apps/web --max-warnings 0

# oxlint, installed outside the workspace
npm i oxlint@1.90.0 oxlint-tsgolint@7.0.2005 @oxlint/migrate@1.90.0   # in a scratch directory
oxlint-migrate eslint.config.mjs --js-plugins=false --details --output-file ox-syn.json
oxlint-migrate eslint.config.mjs --type-aware --js-plugins=false --details --output-file ox-ta.json
oxlint -c ox-syn.json .                 # run from the repository root, so ignorePatterns resolve
oxlint -c ox-ta.json --type-aware .
```

The "residual" ESLint run used a scratch config that spreads `eslint.config.mjs` and appends one
block turning every oxlint-covered rule off, run with `--pass-on-unpruned-suppressions`.

## Rule-by-rule mapping

Every rule enabled in `eslint.config.mjs` (union of the resolved configs for an `apps/web/server`
file, a composition root, a domain core, `packages/core`, `packages/platforms`, an `apps/web/components` path,
a root tool config, a script and the landing-page script), and where it could run. "Could run in"
is capability, not a plan: nothing moved. A note names a divergence measured on today's tree.

| ESLint rule (enabled today)                              | Could run in                      | Note                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@typescript-eslint/await-thenable`                      | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/ban-ts-comment`                      | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-array-constructor`                | oxlint (syntactic)                | as `no-array-constructor` (TS-aware in oxlint)                                                                                                                                              |
| `@typescript-eslint/no-array-delete`                     | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-base-to-string`                   | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-duplicate-enum-values`            | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-duplicate-type-constituents`      | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-empty-object-type`                | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-explicit-any`                     | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-extra-non-null-assertion`         | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-floating-promises`                | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-for-in-array`                     | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-implied-eval`                     | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-misused-new`                      | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-misused-promises`                 | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-namespace`                        | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-non-null-asserted-optional-chain` | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-redundant-type-constituents`      | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-require-imports`                  | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-this-alias`                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-unnecessary-type-assertion`       | oxlint type-aware (tsgolint, TS7) | 1 extra finding                                                                                                                                                                             |
| `@typescript-eslint/no-unnecessary-type-constraint`      | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-argument`                  | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-assignment`                | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-call`                      | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-declaration-merging`       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-enum-comparison`           | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-function-type`             | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-member-access`             | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-return`                    | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-unsafe-unary-minus`               | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/no-unused-expressions`               | oxlint (syntactic)                | as `no-unused-expressions` (TS-aware in oxlint)                                                                                                                                             |
| `@typescript-eslint/no-unused-vars`                      | oxlint (syntactic)                | as `no-unused-vars` (TS-aware in oxlint); 2 extra findings                                                                                                                                  |
| `@typescript-eslint/no-wrapper-object-types`             | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/only-throw-error`                    | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/prefer-as-const`                     | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/prefer-namespace-keyword`            | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/prefer-promise-reject-errors`        | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/require-await`                       | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/restrict-plus-operands`              | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/restrict-template-expressions`       | oxlint type-aware (tsgolint, TS7) |                                                                                                                                                                                             |
| `@typescript-eslint/triple-slash-reference`              | oxlint (syntactic)                |                                                                                                                                                                                             |
| `@typescript-eslint/unbound-method`                      | oxlint type-aware (tsgolint, TS7) | 1 extra finding                                                                                                                                                                             |
| `complexity`                                             | oxlint (syntactic)                | file-scoped with `ignores`                                                                                                                                                                  |
| `constructor-super`                                      | oxlint (syntactic)                |                                                                                                                                                                                             |
| `for-direction`                                          | oxlint (syntactic)                |                                                                                                                                                                                             |
| `getter-return`                                          | oxlint (syntactic)                |                                                                                                                                                                                             |
| `max-depth`                                              | oxlint (syntactic)                | file-scoped with `ignores`                                                                                                                                                                  |
| `no-async-promise-executor`                              | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-case-declarations`                                   | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-class-assign`                                        | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-compare-neg-zero`                                    | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-cond-assign`                                         | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-console`                                             | oxlint (syntactic)                | file-scoped with `ignores`; oxlint overrides cannot express `ignores` (51 false positives after migration)                                                                                  |
| `no-const-assign`                                        | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-constant-binary-expression`                          | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-constant-condition`                                  | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-control-regex`                                       | oxlint (syntactic)                | 1 extra finding                                                                                                                                                                             |
| `no-debugger`                                            | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-delete-var`                                          | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-dupe-args`                                           | ESLint only                       | oxlint: "superseded by strict mode", but `sites/lp/assets/site.js` is a sloppy-mode script                                                                                                  |
| `no-dupe-class-members`                                  | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-dupe-else-if`                                        | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-dupe-keys`                                           | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-duplicate-case`                                      | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-empty`                                               | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-empty-character-class`                               | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-empty-pattern`                                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-empty-static-block`                                  | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-ex-assign`                                           | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-extra-boolean-cast`                                  | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-fallthrough`                                         | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-func-assign`                                         | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-global-assign`                                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-import-assign`                                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-invalid-regexp`                                      | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-irregular-whitespace`                                | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-loss-of-precision`                                   | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-misleading-character-class`                          | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-new-native-nonconstructor`                           | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-nonoctal-decimal-escape`                             | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-obj-calls`                                           | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-octal`                                               | ESLint only                       | as `no-dupe-args`                                                                                                                                                                           |
| `no-prototype-builtins`                                  | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-redeclare`                                           | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-regex-spaces`                                        | oxlint (syntactic)                | 3 extra findings                                                                                                                                                                            |
| `no-restricted-globals`                                  | oxlint (syntactic)                | file-scoped with `ignores` (14 false positives after migration)                                                                                                                             |
| `no-restricted-properties`                               | ESLint only (blocked)             | oxlint implements it, but 18 entries are baselined in `eslint-suppressions.json` and oxlint has no suppressions file; also file-scoped with `ignores` (537 false positives after migration) |
| `no-restricted-syntax`                                   | ESLint only                       | custom AST selectors (F-06, F-07, #1260, core purity) are not implemented in oxlint; 16 baselined entries in `eslint-suppressions.json`                                                     |
| `no-self-assign`                                         | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-setter-return`                                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-shadow-restricted-names`                             | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-sparse-arrays`                                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-this-before-super`                                   | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-unassigned-vars`                                     | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-undef`                                               | ESLint only                       | oxlint: nursery only                                                                                                                                                                        |
| `no-unreachable`                                         | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-unsafe-finally`                                      | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-unsafe-negation`                                     | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-unsafe-optional-chaining`                            | oxlint (syntactic)                | 39 extra findings (implementation differs)                                                                                                                                                  |
| `no-unused-labels`                                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-unused-private-class-members`                        | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-useless-assignment`                                  | ESLint only                       | oxlint: nursery only                                                                                                                                                                        |
| `no-useless-backreference`                               | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-useless-catch`                                       | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-useless-escape`                                      | oxlint (syntactic)                | 11 extra findings                                                                                                                                                                           |
| `no-var`                                                 | oxlint (syntactic)                |                                                                                                                                                                                             |
| `no-with`                                                | oxlint (syntactic)                |                                                                                                                                                                                             |
| `prefer-const`                                           | oxlint (syntactic)                |                                                                                                                                                                                             |
| `prefer-rest-params`                                     | oxlint (syntactic)                |                                                                                                                                                                                             |
| `prefer-spread`                                          | oxlint (syntactic)                |                                                                                                                                                                                             |
| `preserve-caught-error`                                  | oxlint (syntactic)                | 1 extra finding                                                                                                                                                                             |
| `require-yield`                                          | oxlint (syntactic)                |                                                                                                                                                                                             |
| `use-isnan`                                              | oxlint (syntactic)                |                                                                                                                                                                                             |
| `valid-typeof`                                           | oxlint (syntactic)                |                                                                                                                                                                                             |
