# Quarterly debt review

Every baseline in this repository may only shrink. A quarterly review checks that they do, and
decides what to pay down next. On the first day of January, April, July and October the
`Debt review` workflow opens (or refreshes) the issue `Quarterly debt review <year>-Q<n>` with the
current size of each list. The review is done when that issue is closed.

## What is measured

| Baseline                            | Where                                               | Rule                                                                        |
| ----------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| dependency-cruiser known violations | `.dependency-cruiser-known-violations.json`         | delete entries as the import is fixed                                       |
| ESLint suppressions                 | `eslint-suppressions.json`                          | `eslint --prune-suppressions` prunes; never grows                           |
| complexity ceiling                  | `complexity.max` in `eslint.config.mjs`             | equals the measured maximum; lower it when a hotspot shrinks                |
| store-conformance allowlist         | `tests/fitness/store-conformance-allowlist.json`    | a store gains a suite, its entry goes                                       |
| route-error-boundary allowlist      | `tests/fitness/route-error-boundary-allowlist.json` | a route file wraps its methods in `route()`, its entry goes                 |
| storage-limits allowlist            | `tests/fitness/storage-limits-allowlist.json`       | a copy of a storage size limit imports it from its owner, its entry goes    |
| catalog-fakes allowlist             | `tests/fitness/catalog-fakes-allowlist.json`        | a test uses the shared in-memory catalog, its site count drops              |
| osv findings                        | `.osv-baseline.json`                                | entries with a `review by` date are re-decided by that date                 |
| coverage floors                     | `vitest*.coverage.config.ts`                        | raise to the measured value; never lower                                    |
| `ponytail:` shortcuts               | source comments                                     | pay, or restate why the ceiling still holds                                 |
| `it.fails` characterization rows    | tests                                               | a fixed behavior turns the row into `it`                                    |
| proposed ADRs                       | `docs/adr/`                                         | accept, reject or supersede                                                 |
| metrics baseline                    | `docs/metrics/baseline-*.json`                      | run `node scripts/metrics/baseline.mjs`, commit, compare with the last file |

## Procedure

1. Read the issue; compare each number with the previous quarter's issue.
2. For each list: open one pull request that removes the entries already fixed. A number that grew
   is a defect in the review that let it in: find that pull request and say so in the issue.
3. Re-decide every osv entry whose review date has passed. Remove it, or record a new date and
   the reason in `justifications`.
4. Run the metrics baseline and commit the new file.
5. Update the decision ledger and the formal findings status where the project keeps them.
6. Close the issue with a comment linking the pull requests.

Run `node scripts/ci/debt-review.mjs` locally to print the same table.
