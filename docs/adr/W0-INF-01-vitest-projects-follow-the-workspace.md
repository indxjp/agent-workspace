# 0001 · Vitest projects follow the workspace, and no-tests passes

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Owner
- **Context task:** W0-INF-01
- **Supersedes:** nothing. Replaces an undocumented choice made inside W0-INF-01 itself.

## Context

`vitest.config.ts` lists the workspace members that are test projects. Vitest fails a
project that matches no test file, and `apps/web` — a root layout and a placeholder page
— has nothing to test yet. W0-INF-01 resolved that by excluding it:

```ts
projects: ['apps/*', 'packages/*', '!apps/web']
```

with a comment asking whoever first adds testable code under `apps/web` to remember to
delete the line.

Review probed the exclusion rather than reading it. A passing test file dropped at
`apps/web/server/tmp-probe.test.ts` produced:

```
Test Files  5 passed (5)
     Tests  5 passed (5)
```

exit 0. The new test was never executed, and nothing warned. **A test that passes CI
without running is the worst failure mode a test configuration has**, because every
downstream signal — the green check, the count, the exit code — reports success. The
only thing standing between the repository and that state was a future author's memory.

## Decision

`projects` follows the workspace globs with no exclusions, and `passWithNoTests: true`
absorbs the empty project:

```ts
projects: ['apps/*', 'packages/*'],
passWithNoTests: true,
```

## Consequences

- A test file placed anywhere in any workspace member runs from the moment it is
  written. Verified: the same probe now reports `Test Files 6 passed (6)`.
- Adding a workspace member adds a test project automatically — no list to update.
- **The cost, stated plainly:** a member whose tests all disappear now passes instead of
  failing. The failure mode is not removed, it is moved — from "a new test is silently
  skipped" to "a deleted test is silently not missed". That is the better half of the
  trade: writing a test is common and deleting every test in a package is rare and
  visible in review, whereas the previous arrangement punished the common act.
- If the remaining half is ever worth closing, the mechanism is a floor on the test-file
  count asserted in CI, not a return to exclusions.

## Alternatives considered

- **Keep the exclusion, and trust the comment.** Rejected: it had already been probed to
  fail silently, and it asks a future author to act on a constraint they have no reason
  to read.
- **Give `apps/web` a placeholder test, as every other member has.** This would have kept
  `passWithNoTests` off and preserved the "a package with no tests fails" property. It
  was rejected as the *general* answer because it makes every future member carry a
  ceremonial test to stay green, and a ceremonial test is a thing people delete. It
  remains available for `apps/web` specifically once there is anything real to assert.
