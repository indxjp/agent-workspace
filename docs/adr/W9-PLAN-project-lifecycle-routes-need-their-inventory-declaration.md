# ADR-W9-PLAN — Project lifecycle routes need their inventory declaration

Status: accepted
Date: 2026-09-13
Decided by: the Wave 9 orchestrator, during W9.7 pre-flight
Scope: W9-PROJ-124 ownership and the route-inventory acceptance gate

## Context

W9-PROJ-124 explicitly requires two new route families,
`POST /api/projects/:id/archive` and `POST /api/projects/:id/restore`. The repository's route
inventory derives its closed world from tracked files under `tests/route-declarations/**`; a route
that is not declared fails the gate, as ADR-0025 and the W9-RUNS-135 integration repair require.

The W9-PROJ-124 card owns the production route prefix but omitted its task-scoped declaration file.
The plan's later statement that `tests/route-declarations/<TASK-ID>.ts` belongs to the task by
construction does not make the physical `Owns globs:` line cover that file. The ownership checker
therefore cannot accept the complete minimum implementation as written.

This is a false ownership premise in the card, not a reason to weaken or edit
`tests/route-inventory.test.ts`, which remains nobody-owned.

## Decision

Assign the exact file `tests/route-declarations/W9-PROJ-124.ts` to W9-PROJ-124. The task must declare
only the two lifecycle POST routes; it must not edit the inventory test or another task's
declaration.

Both declarations cite spec §3. That section says the frontend must expose simple management
interfaces for the major concepts around the SDK and names Projects in the minimum product
surface. Issue #124 is the binding work item that makes the missing project-lifecycle management
concrete as archive and restore while preserving history. Section 20.5 defines what a Project owns,
and §36 requires project lifecycle changes to be audited, but neither is claimed to contain the
words archive or restore. The declaration's one-line `because` must state this relationship rather
than pretending §34 enumerates either route.

The W9.7 ownership table, task card and disjointness argument are amended together before either
W9.7 implementation task is dispatched. W9-TEAM-122 owns no route-declaration path, so the two
tasks remain disjoint.

## Consequences

- W9-PROJ-124 can add its required routes while keeping the route inventory green and its complete
  diff inside one physical `Owns globs:` line.
- The route declarations cite the actual §3 management requirement and identify issue #124 as the
  lifecycle refinement; they do not invent archive/restore prose in another specification section.
- The implementer must prove the declaration is load-bearing: removing one lifecycle declaration
  while its tracked route remains must make the named route-inventory test fail.
- `tests/route-inventory.test.ts` remains an integration-level gate and is not changed.
