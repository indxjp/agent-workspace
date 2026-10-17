# W2-INT-01 — The nine RBAC routes stay on 503, because the only `DirectoryRoot` in the tree is in memory

Status: accepted (declared gap, and a refusal recorded as a decision)
Date: 2026-09-05
Task: W2-INT-01 (sub-wave 2b-1 integrator)
Scope: `apps/web/instrumentation.ts` — what it deliberately does **not** install

## Context

This task's acceptance criterion is the one no track could state:
[ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md) —
*"every route the sub-wave shipped answers something other than 503 in a deployment built from the
integration branch."* Three of the four subsystems are installed and their routes leave 503. The
fourth, W2-CP-06's, does not, and this record is why.

`configureRbacRuntime` takes two things: an `identify(request)` — which this composition root
already has, and which the session cookie plus `root.resolveMembership` answers — and a
`DirectoryRoot`: `users`, `memberships`, `api_keys`.

There is no durable `DirectoryRoot`. Measured on this branch rather than assumed:

```text
$ ls packages/core/src/db/repositories/
agents.ts  database-reachability.test.ts  index.ts  root.test.ts  root.ts  runs.ts
scope-forgery.test.ts  scope.test.ts  scope.ts  testing.ts  unscoped.ts  violations.ts

$ grep -n 'readonly ' packages/core/src/db/repositories/root.ts | sed -n '/DatabaseRoot/,$p'
  readonly scopes: WorkspaceScopeResolver;
  readonly agents: AgentRepositoryProvider;
  readonly runs: RunRepositoryProvider;
  readonly sessions: SessionRepositoryProvider;

$ grep -rln 'implements DirectoryRoot\|: DirectoryRoot =\|DirectoryRoot {' apps/web/server/rbac/
apps/web/server/rbac/memory-directory.ts
```

The tables exist — `packages/core/src/db/schema/{users,memberships,api-keys}.ts` all shipped with
W2-DB-01 — and the repositories over them do not. `apps/web/server/rbac/directory.ts`'s own header
says so and says why: *"the durable implementation of this port cannot be written from inside this
task's `Owns` globs, and pretending otherwise by reaching around the barrel would reopen the
tenant-isolation bypass 2a closed."* `@agent-workspace/core/db` deliberately exports no queryable
handle, and `@agent-workspace/core/db/unscoped` refuses to load outside a test process by design,
so there is no module this composition root could write a directory against either.

## Decision

**Install nothing, log the reason at start-up, and declare the gap. Do not install
`createMemoryDirectory()`.**

The in-memory directory exists, is complete, and enforces the same constraints PostgreSQL does.
Installing it would take nine routes off 503 in a single line, and every one of the nine would then
be wrong in the same direction:

- `GET /api/users` and `GET /api/memberships` would report a workspace with **no members**, while
  `users` and `memberships` hold the bootstrap administrator that `root.resolveMembership`
  authorises every other request in the process against. An authorisation directory that disagrees
  with the database doing the authorising is not a partial implementation; it is a second, wrong
  answer to the question the first one already answers.
- `POST /api/memberships` would grant a role that authorises nothing, and `PATCH` would change one
  that was never consulted.
- `POST /api/api-keys` would mint a key, show it **once** — §22's rule, so it is unrecoverable —
  and stop authenticating at the next restart, with nothing to distinguish that from a revocation.

[ADR-0035](0035-an-acceptance-criterion-needing-a-resource-this-deployment-lacks-is-a-declared-gap-not-a-claim.md)
is explicit that a weaker substitute is never reported as a criterion met, and
`apps/web/instrumentation.ts`'s own header already committed this program to the same rule for the
agent store: *"There is no silent fallback to memory."* The 503 says
`rbac_runtime_not_configured`, which is a true sentence about this deployment. Nine wrong 200s are
not.

The refusal is written into the composition root as a function — `reportRbacNotInstalled()` — that
installs nothing and prints the reason with the remediation, rather than as an absence. An absent
call is indistinguishable from a forgotten one, which is the shape this whole sub-wave exists to
correct.

## Consequences

- **`GET|POST /api/users`, `GET|POST /api/memberships`, `PATCH|DELETE /api/memberships/:id`,
  `GET|POST /api/api-keys` and `DELETE /api/api-keys/:id` answer `503 rbac_runtime_not_configured`
  in a deployment built from this branch.** Nine routes, derived from
  `tests/route-declarations/W2-CP-06.ts` rather than counted here, and measured by this task's
  non-503 probe rather than asserted.
- The remediation is named and is one task's worth of work, not this one's: `users`,
  `memberships` and `api_keys` repositories under `packages/core/src/db/repositories/**`, exposed
  on `DatabaseRoot` the way `agents`, `runs` and `sessions` already are, and an adapter from those
  to `apps/web/server/rbac/directory.ts`'s port. That glob is W2-DB-02's
  (the Wave 2 plan's 2a row), the port is deliberately shaped as *"a translation rather
  than a redesign"* of the repository layer, and W2-CP-06's whole suite already holds any
  implementation of it to the same behaviour.
- **Everything achievable without that resource is still verified** (ADR-0035): W2-CP-06's own 121
  tests pass on the union, its authorisation matrix decides every declared route including the four
  W2-CP-07 added, and the 503s themselves are driven and shown rather than inferred from the
  wiring.
- The `identify` half was never the blocker and is not the reason this is skipped. If a durable
  directory lands, the call is three lines in `apps/web/instrumentation.ts` and the authenticator
  it needs is already built there.

## Alternatives rejected

**Install `createMemoryDirectory()` and declare the non-durability.** Rejected above: the failure
is not that the data is lost on restart, it is that the answers are wrong while the process is
running, on a §21/§22 security surface.

**Install it behind an opt-in variable and use that deployment for the non-503 proof.** That is
ADR-0035's forbidden move with an extra step — a weaker substitute, reported as the criterion met,
with the substitution documented somewhere the reader of the acceptance table does not look.

**Write the three repositories here.** It is a track's worth of tenant-scoped query code with its
own tenancy tests, inside another task's `Owns` glob, and every decision it would make is one
`apps/web/server/rbac/directory.ts` has already specified. ADR-0038 makes composition the
integrator's; it does not make the persistence layer the integrator's.

## Related

- [ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
  — the criterion this record partially fails, and the reason this task exists.
- [ADR-0035](0035-an-acceptance-criterion-needing-a-resource-this-deployment-lacks-is-a-declared-gap-not-a-claim.md)
  — the rule that makes a declared gap the honest answer and a substitute the dishonest one.
- [ADR-0015](0015-gates-decide-on-positive-assertions.md) — why the 503 is the right answer for a
  capability nobody configured.
- `docs/adr/W2-DB-02-no-silent-memory-fallback.md` — the same decision, taken by the task that
  wrote this composition root, about the agent store.
