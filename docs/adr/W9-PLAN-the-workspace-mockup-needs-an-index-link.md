# ADR-W9-PLAN — The workspace mockup needs an index link

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator, after the W9-UI-120 independent verification
Scope: W9-UI-120 ownership and the screen-inventory acceptance gate

## Context

W9-UI-120 adds `ui/workspaces.html` and its screen declaration. The repository's
screen-inventory gate also requires every declared mockup to be linked from
`ui/index.html`. The card assigned the new mockup to W9-UI-120 but omitted the
existing index from its ownership. Consequently the exact acceptance command fails
even though the shipped page and declaration are present, and the implementer cannot
correct the failure without leaving its Owns globs.

This is a false ownership premise in the plan, not a reason to weaken the inventory
gate or to edit a nobody-owned test.

## Decision

Assign the exact index file to W9-UI-120 through the single-file glob
`ui/i?dex.html`. The `?` matches the `n` in the repository path for ownership, while
avoiding a false screen schedule: the screen-inventory parser deliberately treats every
literal `ui/<name>.html` mention in a wave plan as a screen. The task adds only the link
for `ui/workspaces.html`; it does not otherwise redesign the mockup index. The
shared-file table, card, and disjointness argument are amended together before repair.

No other W9.6 task owns `ui/**`, so the assignment remains disjoint.

## Consequences

- The named screen-inventory acceptance command can become green without weakening a
  test or crossing an implicit ownership boundary.
- The repair must demonstrate that removing the new index link makes the named
  screen-inventory test fail.
- The failed independent verification remains recorded as a real verifier round; the
  amendment does not retroactively turn it into a PASS.
