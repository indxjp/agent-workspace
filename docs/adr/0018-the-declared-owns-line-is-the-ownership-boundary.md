# ADR-0018 — The PR's declared `Owns:` line is the boundary; the plan's task card is indicative

Status: accepted
Date: 2026-09-03
Decided by: orchestrator, ruling on four standing ratification requests from Wave 1a
Scope: whole programme

## Context

Four Wave 1a tasks ended their verification with the same standing item, addressed to the
orchestrator and correctly left unresolved by the verifier: *the PR declares more `Owns:` globs than
the development plan §6 grants.* Examples, all honestly declared and none disputed:

| Task | Plan grants | PR also declares | Why |
| --- | --- | --- | --- |
| W1-DB-01 | `packages/core/src/db/**`, `migrations/**` | `pnpm-workspace.yaml` | pnpm 11 fails the install without an install-script answer |
| W1-CP-06 | `apps/web/server/auth/**` | `apps/web/middleware.ts`, `tests/auth.test.ts` | the middleware *is* the prefix rule; the test is named by its own acceptance criterion |
| several | — | `docs/adr/<TASK-ID>-*.md` | ADR-0003 grants it by construction |
| several | — | `docs/adr/README.md` | generated; the index gate is blocking and the task adds a record |

The plan's §6 task cards were written before any code existed. They name the *substance* of a task,
not an exhaustive file manifest, and they could not have known that pnpm 11 would demand an install
answer or that Next.js's middleware file is where a path-prefix rule has to live. Treating them as
exhaustive produces one of two bad outcomes: a task that cannot complete, or a task that completes by
quietly writing outside its declaration — and the second is the one that destroys the parallelism
guarantee, because the ownership gate reads the *declaration*, not the plan.

The plan already anticipates this. §2.3's remedy for an intersection is "the plan is wrong, so fix
the plan", and §8.7 treats a genuine collision as an ownership violation to be corrected in the plan.
Nothing there says a task may not need a file the card did not foresee.

## Decision

**The effective ownership boundary is the `Owns globs:` line in the PR body**, subject to three
conditions, all mechanically checked:

1. It is **disjoint from every sibling at the same stack level**. This is the property §2.3 buys
   parallelism with, and it is the only one that matters for correctness.
2. The CI ownership gate passes against it — every changed file is inside it.
3. Each glob outside the plan's card is **declared with its reason** in the PR body's Ownership
   section. A file added silently remains a violation; the declaration is the whole control.

Three grants are made programme-wide so tasks stop asking:

- `docs/adr/<TASK-ID>-*.md` — every task, by construction (ADR-0003).
- `docs/adr/README.md` — every task that adds a record. It is **generated**; conflicts are resolved
  by re-running `docs/adr/regenerate-index.sh`, never by hand-merging (ADR-0016, ADR-0017 rule 3).
- The test file **named by a task's own acceptance criterion**. An acceptance criterion that names a
  file the task may not write is incoherent.

Ratified specifically, for Wave 1a: `pnpm-workspace.yaml` (W1-DB-01), `apps/web/middleware.ts` and
`tests/auth.test.ts` (W1-CP-06), and every task's `docs/adr/` files above.

## Alternatives considered

- **Amend §6's task cards to list every file.** Rejected: the development plan is the Owner's
  document and §0 rule 1 makes the spec authoritative over it; more importantly the list cannot be
  written in advance, which is what Wave 1a demonstrated four times in one wave.
- **Require an amendment PR before a task may widen its globs.** Rejected: it serialises every wave
  behind a plan edit, and the widening is usually discovered mid-task. The declaration plus the CI
  gate already give a reviewer everything the amendment would.
- **Let tasks write anywhere and rely on review.** Rejected outright — that is the parallelism
  guarantee gone, and §2.3 is the only reason concurrent tasks are safe at all.

## Consequences

- The plan and the PRs will diverge, permanently and by design. The wave manifest records the
  divergence per task so a reader is not surprised.
- A reviewer must now read the Ownership section rather than trusting the card. That is more work,
  and it is where the declaration earns its keep.
- Two PRs may legitimately declare `docs/adr/README.md` at once. That is safe **only** because it is
  generated and the merge rule is "re-run the script". If a hand-written shared file ever appears in
  two declarations, condition 1 has been violated and the plan must be fixed.
- Nothing here relaxes the rule that an **undeclared** change is a violation. The boundary moved from
  the plan to the PR; it did not disappear.
