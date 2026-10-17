# W9-PLAN — One migration per wave, and that is what sets Wave 9's wave count

Status: accepted
Date: 2026-09-11
Decided by: W9-PLAN-00 (the Wave 9 planner)
Scope: `migrations/**` ownership across Wave 9; the number of waves Wave 9 has

## Context

Seven of the twenty-one Wave 9 issues need a schema change. The Ownership section names them:
`#117` (resource ownership columns and a Viewer grant table), `#118` (an OIDC identity mapping),
`#129` (workspace/project default model, run connection snapshot), `#134` (an accounting state),
`#119` (workspace archive), `#121` (an invitations table), `#124` (project archive). Each of the seven
is required by the issue's own acceptance criteria, not by a design preference; the Wave 9 plan's
migration table pastes the command that shows the column is absent today for each one.

A migration in this repository is not one file. `pnpm db:generate` writes
`migrations/NNNN_<name>.sql`, `migrations/meta/NNNN_snapshot.json`, **and rewrites
`migrations/meta/_journal.json`**. The first two are per-migration and could be partitioned by a glob;
the journal cannot. It is one array, appended to by every generate, and two branches that both
generate produce a conflict in it whose resolution is not mechanical — the order of the entries is the
migration order, and choosing it is a decision, which is precisely
[ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)'s test for a file that may not be
shared.

Under [W9-PLAN-waves-branch-from-main-not-from-each-other](W9-PLAN-waves-branch-from-main-not-from-each-other.md)
there is no integration level to resolve such a conflict, and sibling branches in one wave never see
each other, so two siblings would each generate `0010_*` against the same journal.

## Decision

**At most one task per wave owns `migrations/**`.** Because seven Wave 9 issues need a migration,
**Wave 9 has at least seven waves, and the plan has exactly seven.**

1. The migration owner of each wave is named in the plan's shared-file table:
   W9.1 → W9-AUTH-117, W9.2 → W9-AUTH-118, W9.3 → W9-MODEL-129, W9.4 → W9-RUNS-134,
   W9.5 → W9-WS-119, W9.6 → W9-TEAM-121, W9.7 → W9-PROJ-124.
2. No other task in that wave declares `migrations/**`, and a task that discovers it needs a
   migration has found a planning defect and escalates under §3.5 rather than generating one.
3. A wave's migration owner also owns `packages/core/src/db/schema/index.ts` in that wave, because a
   new table has to be exported from the barrel for `drizzle-kit generate` to see it.
4. Every migration-owning card runs `pnpm db:generate` and `git status --porcelain migrations` as
   acceptance and pastes the output, so a committed migration that does not correspond to the
   committed schema is caught on the branch rather than at the next wave's generate.

The wave *ordering* is then a scheduling problem with two constraints — the dependency graph, and one
migration slot per wave — and the plan's ordering is the shortest schedule that satisfies both. It
puts the provider/model/runs chain first (`#127`, then `#126`, then `#129`, `#134`, `#135`, `#136`)
because that chain is five edges long and is the binding constraint; the identity/workspace/team chain
(`#118` → `#119` → `#121` → `#122`) is four edges and fits in the slots that remain.

Two migrations were *removed* rather than scheduled, and each is recorded separately because each is a
narrowing of an issue:
[W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key](W9-PLAN-credential-ownership-is-a-repository-invariant-not-a-foreign-key.md)
takes `#126` out of the migration set, which is what frees the W9.2 slot for `#118`, and
[W9-PLAN-project-file-grants-are-read-only-in-wave-9](W9-PLAN-project-file-grants-are-read-only-in-wave-9.md)
takes `#125` out, which is what lets it share W9.4 with `#134`. Without those two narrowings Wave 9
would need nine waves.

## Consequences

- Seven waves for twenty-one tasks, so the average wave runs three tasks where the plan permits six.
  The constraint is the journal, not the task count, and pretending otherwise by packing more tasks
  into fewer waves would produce a plan whose first conflict is in a generated file nobody can
  mechanically resolve.
- `#124` (project archive) lands in the last wave although it depends only on `#123`, which lands in
  the first. That is the visible cost of the constraint: it is a P1 issue occupying the only remaining
  migration slot, and moving it earlier would displace `#119`, which four other issues depend on.
- A wave whose migration owner fails does not block its siblings, because they do not base on it.

## Alternatives rejected

**Partition `migrations/**` by number — one task owns `migrations/0010_*`, another `migrations/0011_*`.**
The per-migration files partition cleanly and `migrations/meta/_journal.json` does not. Two tasks
would still collide on the journal, and the collision would be in the one file whose correct
resolution is an ordering decision.

**One "schema foundation" task per wave that ships every migration that wave needs.** This is the
§2.3 first-row mechanism — make the shared schema file the first task, alone at its level — and it was
seriously considered. Rejected because a task that writes `#117`'s ownership backfill, `#118`'s
identity table and `#119`'s archive column is not a task, it is three tasks in one PR with three sets
of acceptance criteria and no single reviewer who can hold it. It also re-introduces stacking: the
wave's other tasks would have to base on it to see the schema.

**Let siblings generate and resolve the journal at merge.** There is no integration level in Wave 9
to do it, and the resolution is a decision rather than a re-derivation, so it fails ADR-0019's test
and ADR-0037's test both.

## Related

- [W9-PLAN-waves-branch-from-main-not-from-each-other](W9-PLAN-waves-branch-from-main-not-from-each-other.md)
  — why there is no integration level to resolve a journal conflict.
- [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) — the "resolved by deciding, not
  by re-deriving" test that `_journal.json` fails.
- [ADR-0037](0037-the-adr-index-is-generated-not-owned-so-a-conflict-in-it-is-resolved-by-regenerating.md)
  — the contrasting case: a generated file whose conflict *is* resolved by re-deriving.
