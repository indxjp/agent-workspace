# ADR-W9-PLAN — The composition root moved after the plan was written; W9.5–W9.7 ownership is re-cut around it

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator (plan amendment, before W9.5 dispatch)
Scope: the Wave 9 plan — the shared-file table and the `Owns` cells/cards of `W9-WS-119`, `W9-UI-133`, `W9-SEC-149`, `W9-PROJ-153`, `W9-TEAM-121`, `W9-PROJ-124`

## Context

Between W9.4 landing (PR #151, 2026-09-11) and this amendment, two pull requests outside Wave 9
merged to `main`: #156 (TypeScript cleanup and quality gates) and #157 ("harden architecture and
share accounting", commit `d1e7598`). #157 changed the shape the plan's shared-file table was
written against:

- `apps/web/instrumentation-node.ts` — the composition root the plan assigns per wave — shrank
  to an eight-line re-export. The root now lives in `apps/web/server/composition/**`:
  `register.ts` (the seam installation order, `resolveWorkspace`, `installRunApi`'s closures),
  `services.ts` (`installModelsApi`, `installConnectorsApi`, …), `session-rbac.ts`
  (`installRbacApi`, session transcripts), `storage.ts`, `setup.ts`, `config.ts`, `identity.ts`,
  `types.ts`.
- `apps/web/contracts/{agents,projects}.ts` (with tests) were added: shared zod contracts the
  agent and project components and routes now import.
- `packages/core/src/db/repositories/root.ts` is where `DatabaseRoot` — the object every
  installer reads repositories from — is defined and built. The plan's `W9-WS-119` cell names
  `repositories/workspaces.ts` and `repositories/index.ts` but not `root.ts`, and a
  `WorkspaceRepository` that no installer can reach is not a workspace API.
- Migration `0014_premium_vengeance.sql` was added, so the next migration is `0015`.

Confirmed mechanically before dispatch: `git grep -n resolveActor origin/main -- apps/web/instrumentation-node.ts`
prints nothing; `git ls-tree -r --name-only origin/main -- apps/web/server/composition` lists the
eight files above; `git grep -n "interface DatabaseRoot" origin/main -- packages/core/src/db`
answers `repositories/root.ts:146`.

The plan's rule is unchanged: one owner per shared file per wave, and a task that needs a file
outside its `Owns` escalates. What changed is which files are shared.

## Decision

1. **The shared-file table gains a row for `apps/web/server/composition/**`.** Its cells for
   W9.1–W9.4 say `did not exist` (those waves edited `instrumentation-node.ts`, and the historical
   row keeps saying so). For W9.5 the row is cut **by file**: `services.ts` → `W9-SEC-149` (it is
   the only W9.5 task whose change is in `installModelsApi`), and `register.ts` + `session-rbac.ts`
   → `W9-WS-119` (the workspace routes must be installed, and the archived-workspace refusal for
   new runs belongs in `register.ts`'s `findAgent`/`openSession` closures, not in
   `apps/web/server/runs/**`, which is `W9-RUNS-135`'s). Every other composition file is nobody's in
   W9.5. For W9.6 the whole directory is `W9-TEAM-121`'s; for W9.7 it is `W9-PROJ-124`'s — in both
   waves the migration owner is the only task that installs anything.
2. **`packages/core/src/db/repositories/root*.ts` gains a row**, owned by the wave's migration
   owner where that owner adds a repository (`W9-WS-119`, `W9-TEAM-121`, `W9-PROJ-124`) and by
   nobody otherwise. `W9-WS-119`'s `Owns` also widens `workspaces.ts` to `workspaces*.ts` so the
   repository's own PostgreSQL-backed test is inside its globs — the W9-PROJ-125 lesson
   (an exact filename with no test wildcard left its repository guard untestable inside Owns).
3. **`apps/web/contracts/agents*.ts` → `W9-UI-133`** (the assignment editor is the only W9.5
   consumer) and **`apps/web/contracts/projects*.ts` → `W9-PROJ-153`** in W9.5, `W9-PROJ-124` in
   W9.7. A card that does not need the contract file leaves it untouched; owning it is what makes
   a needed change legal without a mid-wave escalation.
4. **`W9-WS-119`'s slug bullet is corrected.** `workspaces_slug_key` (unique) and the
   `workspaces_slug_format` CHECK already exist on `main`; the migration adds `archived_at` only.

`node scripts/check-wave-ownership.mjs <Wave 9 plan>` reports every level pairwise disjoint
after these edits; the output is pasted on the amendment PR.

## Alternatives rejected

- **Leave the table as written and let the first task that hits `composition/**` escalate.**
  Rejected: the escalation is certain (`W9-WS-119` cannot ship a route nobody installs, and
  `W9-SEC-149`'s defect *is* in `services.ts`), so it would cost a resume round for a fact already
  known at dispatch time.
- **Give the whole `composition/**` directory to one W9.5 task.** Rejected: two W9.5 tasks
  genuinely need two different files in it, and the other would have to escalate. Exact filenames
  are in the glob dialect both checkers implement.
- **Serialise W9.5 into two levels so one task at a time owns the directory.** Rejected: an extra
  CI/merge cycle to avoid a per-file split the tooling already supports.

## Consequences

- A W9.5 verifier compares `git diff --name-only origin/main...HEAD` against an `Owns` line that
  names exact composition files; a change to `register.ts` on `W9-SEC-149`'s branch, or to
  `services.ts` on `W9-WS-119`'s, is a blocking finding.
- The orchestrator's manual pairwise diff-disjointness check before merging W9.5 (the
  ownership gate's sibling blind spot, ADR-0050 when written) now has a concrete thing to catch:
  two branches both touching one composition file.
- The Wave 9 status report's snapshot of the tree is stale on these points and is
  corrected at wave close, not here (that file is assigned to nobody in any wave).
