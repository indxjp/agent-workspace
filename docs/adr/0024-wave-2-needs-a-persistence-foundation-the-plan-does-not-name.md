# ADR-0024 — Wave 2 needs a persistence foundation the plan does not name, and it is a task rather than an obligation on six others

Status: accepted
Date: 2026-09-04
Decided by: orchestrator
Scope: Wave 2 sub-wave 2a; `packages/core/src/db/**`, the control-plane stores

## Context

Wave 1 shipped a schema and a migration, and shipped **no code that reads or writes the database**.
Both statements are checkable rather than remembered:

```
$ grep -rln "drizzle-orm" --include=*.ts apps packages | grep -v '^packages/core/src/db/'
(no output)
$ ls apps/web/server/agents/memory-store.ts
apps/web/server/agents/memory-store.ts
```

Agents and runs live in process-local `Map`s. The wave handoff notes §4 declares this openly, and
in Wave 1 it was the right trade: the wave's exit criterion was one streamed run, and a restart
losing it cost nothing anyone had been promised.

Wave 2 is six new resource subsystems — secrets, files, skills, connectors, users and API keys,
sessions — and their acceptance criteria are not satisfiable against a `Map`:

- W2-CP-02: _"a secret value never appears in any API response, log, or audit row"_ — an audit row
  is a table.
- W2-CP-06: _"authorisation matrix test: 4 roles × every route"_ — memberships are rows.
- W2-CP-07: _"kill the runtime mid-session, start a fresh one, resume: the conversation continues"_
  — this is the §14.9 release blocker, and it is a statement about **surviving process death**. It
  cannot be met by anything in a process.

The plan does not name a persistence task. Its twelve cards assume the adapter exists. If nothing
is done, each of the six tracks writes its own way of reaching Postgres, in parallel, without seeing
the others — six connection strategies, six answers to workspace scoping, six transaction shapes,
converging at the integration branch. That is the same category error as
[ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md): a concern that quantifies over
the whole repository, handed to owners of one glob each.

## Decision

1. **Sub-wave 2a gains a task the plan does not have: `W2-DB-02`, the repository layer.** It owns
   `packages/core/src/db/repositories/**` and the two existing memory stores it replaces. It ships
   the shape every later resource follows: a repository interface, a Drizzle-backed implementation, a
   workspace-scoped query helper that takes a `WorkspaceScope` and cannot be called without one, and
   the same contract test suite run against both the in-memory and the PostgreSQL implementation.
2. **It converts agents and runs first**, before any Wave 2 resource exists. Converting the two
   subsystems that already have callers and tests proves the layer against real usage rather than
   against its own fixtures, and it is the only way the six parallel tracks receive a pattern instead
   of a promise.
3. **The in-memory implementations are kept, not deleted.** They are what the unit tests run against
   and what `docker compose up -d` falls back to when no database is reachable. The contract suite
   running against both is the gate that keeps them the same thing —
   [ADR-0015](0015-gates-decide-on-positive-assertions.md)'s shape: two implementations agree because
   a test asserts it, not because one was written by reading the other.
4. **Spec §25 becomes enforceable here.** Wave 1's `WorkspaceScope` is a nominal type whose
   _possession_ is checked by the compiler while its _use in every query_ was declared a contract and
   not a gate (`apps/web/server/auth/index.ts` says so in its own doc comment). A repository layer
   that takes the scope as a constructor argument and builds the `where` clause itself moves that
   from contract to construction.

## Alternatives considered

- **Add "and persist it" to each of the six track briefs.** Rejected: it is the obligation-on-six-
  others shape that [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md)
  rejected for dependencies and ADR-0019 rejected for gates. Six parallel authors cannot converge on
  one pattern by being told to.
- **Defer persistence to Wave 2c's integrator.** Rejected: the integrator would rewrite six
  subsystems it did not write, at the point in the wave with the least remaining budget, and
  W2-CP-07's acceptance criterion would have been unmeetable for the whole of 2b.
- **Leave everything in memory for Wave 2 and persist in Wave 3.** Rejected: it makes §47's
  completion criterion false — a non-technical user who configures files, skills and connectors
  through the UI and restarts the container has configured nothing.

## Consequences

- Sub-wave 2a is three serial tasks rather than one, and 2b starts later.
- `W2-DB-02` touches `apps/web/server/agents/store.ts` and `apps/web/server/runs/store.ts`, which
  W1-CP-05 and W1-CP-04 wrote. It is the sole owner of them for this wave, declared in
  the Wave 2 plan, and no 2b task may touch either.
- If the layer is wrong, it is wrong in one place. That is the point, and it is also the risk: a
  defect here is a defect in six subsystems. Its verifier is briefed accordingly.
- This is a **plan defect**, the fifth found (the wave handoff notes §5 lists
  four). Recorded rather than worked around, as plan §2.3 requires.
