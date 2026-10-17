# W9-PLAN — Wave 9's waves branch from `main`, not from each other

Status: accepted
Date: 2026-09-11
Decided by: W9-PLAN-00 (the Wave 9 planner), on the Owner's explicit simplicity requirement
Scope: the branching and landing protocol for every task of Wave 9 (issues #116 … #136); deviates
from §8 of the development plan and from [ADR-0001](0001-no-merge-to-main-wave-integration-branches.md);
inherits [ADR-0020](0020-the-stack-lands-on-main-by-merge-not-squash.md) unchanged

## Context

§8 of the development plan specifies a stacked-PR protocol: a wave's tasks each branch from the
previous task's branch, and the whole stack lands through one wave integration branch
(ADR-0001, ADR-0034). Waves 1 through 8 were executed that way, and the protocol earned its place —
`docs/adr/0011-unauthorised-agent-merges-and-the-restack.md` and
`docs/adr/0013-wave-1-ownership-split-and-substacks.md` are both records of what it caught.

Wave 9 is a different shape of work. It is twenty-one issues, not five or six tasks, and the
dependency graph between them is deep rather than wide: the longest chain is
`#126 → #129 → #134 → #135 → #136`. A single stack over twenty-one tasks has two costs the earlier
waves did not pay at this magnitude:

1. **Restack cascade.** Any change to a branch near the bottom rewrites the base of every branch
   above it. Over twenty-one branches, a single review comment on the first task is twenty rebases,
   each of which can conflict, and each of which invalidates the CI run of every branch above.
2. **Nothing in the graph needs it.** A stack exists so that a later task can *build on* an earlier
   task's code before it has landed. Wave 9's dependency edges are all cross-wave — `#132` needs
   `#131` landed, not `#131` in progress — and within a wave the tasks are, by the Ownership
   section's construction, file-disjoint and mutually independent.

The Owner's instruction on this point is explicit: simplicity is the requirement.

## Decision

**Every Wave 9 task branches from `main` as `main` stands after the previous wave has landed. There
is no stacked-PR chain and no wave integration branch.**

Concretely:

1. **`Base: main` on every task card.** A wave is a set of sibling branches off one commit of `main`,
   not a chain.
2. **A dependency is a wave boundary.** If task B needs task A's code, A is in a strictly earlier
   wave. There is no "B bases on A" within a wave, so a task may never import a sibling's new
   module. The Wave table's dependency column is the only mechanism.
3. **Landing is a real merge, per ADR-0020.** Each task's PR lands on `main` with
   `gh pr merge --merge`. ADR-0020's reason — that a squash discards the per-task commits the
   ownership and attribution record is built from — is about what a merge preserves, not about stack
   position, so it applies to a flat set of branches unchanged.
4. **The ownership gate runs in `--pr` mode for every Wave 9 PR.** There is no merge of sibling
   branches into an integration branch, so no PR body carries a `Merged <ref>:` line and
   [ADR-0033](0033-the-ownership-gate-mode-is-selected-by-the-pr-body-not-by-the-commit-shape.md)'s
   mode selection lands on `--pr` for all of them. `--integration` mode is not used in Wave 9.
5. **The integration level's two residual duties become the Owner's wave-close step.** ADR-0037
   item 4 gives `docs/adr/README.md`'s final regeneration to the integration level, and
   [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) gives repository-wide gates
   and root configuration to it. With no integration level: the index is regenerated once by the
   Owner after each wave lands, and **no Wave 9 task owns a repository-wide gate or root
   configuration file at all** — the Ownership section assigns them to nobody, and a task that needs
   one escalates under §3.5 instead of editing it.

## Consequences

- Twenty-one branches, each with one merge-base, and no rebase is ever required for a reason other
  than a genuine conflict with landed `main`.
- A wave's siblings cannot see each other, which is a real loss of flexibility. It is paid for once,
  in the wave table, by putting every dependency edge on a wave boundary — and that table is
  checkable by reading it, which a twenty-one-deep stack's ordering is not.
- Seven waves means seven sequential landings rather than one. That is slower in wall-clock terms
  than an ideal stack and faster than a stack that restacks, which over twenty-one branches is the
  realistic comparison.
- The per-wave disjointness rule does *more* work here than under stacking, because it is now the
  only thing keeping siblings apart. `scripts/check-wave-ownership.mjs` runs on
  the Wave 9 plan in CI, so the plan's claim is decided rather than asserted.

## Alternatives rejected

**One twenty-one-deep stack, as §8 specifies.** Rejected on the restack cost above. The protocol is
not wrong; it is sized for a wave of five or six tasks, which is what §6 of the plan describes.

**Seven stacks, one per wave, each with an integration branch.** This is §8 applied per wave and was
the closest alternative. Rejected because within a wave the tasks are already file-disjoint and
independent, so the stack buys nothing, while the integration branch adds a seventh artefact per wave
plus `--integration` mode's `Merged <ref>:` bookkeeping. The Owner asked for the simpler structure
and this is where the simplification is available for free.

**Flatten further: all twenty-one branches off one `main`, no waves.** Rejected because the
dependency edges are real. `#136` cannot be written before `#135` exists, and a plan that pretends
otherwise produces a task that cannot be finished.

## Related

- [ADR-0020](0020-the-stack-lands-on-main-by-merge-not-squash.md) — landing by merge; inherited.
- [ADR-0001](0001-no-merge-to-main-wave-integration-branches.md) — the convention this deviates from.
- [ADR-0033](0033-the-ownership-gate-mode-is-selected-by-the-pr-body-not-by-the-commit-shape.md) — why
  `--pr` rather than `--integration` is selected by the body and not by the commit shape.
- [ADR-0037](0037-the-adr-index-is-generated-not-owned-so-a-conflict-in-it-is-resolved-by-regenerating.md)
  — item 4's integration-level duty, reassigned here.
- [W9-PLAN-one-migration-per-wave-sets-the-wave-count](W9-PLAN-one-migration-per-wave-sets-the-wave-count.md)
  — why there are seven waves rather than five.
