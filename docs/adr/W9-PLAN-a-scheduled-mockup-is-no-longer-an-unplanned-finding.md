# ADR-W9-PLAN — A mockup the plan schedules is no longer an unplanned finding

Status: accepted
Date: 2026-09-11
Decided by: W9-PLAN (planner) · repaired by the orchestrator after CI
Scope: `tests/screen-declarations/W2-INT-00.ts`, and the ownership of that file in W9.6

## Context

The Wave 9 plan added no product code, yet it turned the `Test` step of CI red. The two
failures came from one repository-wide gate:

```
FAIL  tests  screen-inventory.test.ts > every ui/*.html mockup is declared, and every page that
ships is declared > dates every deferral from the plan’s own task cards, in both directions
AssertionError: expected [ Array(1) ] to deeply equal []
+   "ui/run.html (W2-INT-00): declared unplanned, but the plan schedules it in W9. Declare it
+    planned for that wave.",

FAIL  tests  screen-inventory.test.ts > … > holds the mockups nothing schedules as a set derived
from the plan, not a literal
AssertionError: no wave section of the plan names these mockups: (none): expected
[ 'ui/run.html' ] to deeply equal []
```

The gate reads every Wave plan, derives the set of `ui/*.html` mockups the wave
sections schedule, and compares it against `tests/screen-declarations/**`. `ui/run.html` was
declared `status: 'unplanned'` by W2-INT-00 with the evidence *"no task card in the plan names this
mockup"*. W9-UI-136's card names it. The declaration did not become wrong when this plan was
written — it **was** right, and the plan is what made it stale.

This is the failure mode [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) names:
a closed-world assertion over the whole tree cannot be satisfied by the task that changes one part
of it, so the change that invalidates it must also repair it.

## Decision

The plan PR flips the `ui/run.html` entry in `tests/screen-declarations/W2-INT-00.ts` from
`status: 'unplanned'` to `status: 'planned'`, `wave: 'W9'`, and records in its `because` line that
W9-UI-136 builds it. `tests/screen-declarations/W2-INT-00.ts` is declared on the plan PR's own
`Owns globs:` line with this record as the reason
([ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md): the declared line is the
boundary, and a card-external glob is admissible when it is declared with a reason and is disjoint
from every sibling at the same level).

The same file is added to **W9-UI-136's** `Owns globs`, and to no other Wave 9 task's. W9-UI-136
flips the entry a second and final time — to `shipped`, with its `route` and `page` — when it ships
the screen. Its W9.6 siblings are W9-TEAM-121, which owns no screen declaration, and W9-UI-120,
which owns only `tests/screen-declarations/W9-UI-120.ts`, so the level stays disjoint.

## Alternatives considered

- **Leave the entry `unplanned` and relax the gate.** Rejected. The gate is correct: it caught a
  real inconsistency between the plan and the declarations on the first PR that could produce one.
  Weakening a check because a correct change tripped it is how
  [ADR-0015](0015-gates-decide-on-positive-assertions.md)'s fail-open pattern gets installed.
- **Leave it to W9-UI-136 in W9.6.** Rejected: it would leave `main` red from the moment the plan
  merges until W9.6 lands — five waves of a red required check, which would also mask every real
  failure in between.
- **Give the file to the orchestrator's integration level instead.** Rejected as heavier than the
  problem. The entry needs exactly two edits by exactly two known authors, and both are named here.
- **Write the mockup out of the W9-UI-136 card so the plan schedules nothing.** Rejected: it would
  buy a green gate by making the plan less true. The screen is genuinely what #136 builds.

## Consequences

- The plan PR touches a test-fixture file outside `docs/`, which a reader of its diff will not
  expect. That is what this record is for.
- Between this merge and W9.6, `ui/run.html` is declared `planned` while no screen exists. That is
  the honest state, and it is exactly the state `planned` was added to express.
- If W9-UI-136 is ever dropped from Wave 9, this entry must go back to `unplanned` with a fresh
  `because`, or the gate will be wrong in the opposite direction. Reversing the plan means reversing
  this declaration in the same PR.
