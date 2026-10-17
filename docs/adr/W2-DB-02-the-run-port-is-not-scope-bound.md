# W2-DB-02 — The run store's port identifies a run by id alone, and the one unscoped query that follows is named rather than hidden

Status: accepted
Date: 2026-09-04
Decided by: W2-DB-02 (Persistence)
Scope: `apps/web/server/runs/store.ts`, `packages/core/src/db/repositories/runs.ts`

## Context

The property this task exists to install is that **a repository cannot run a query that forgets the
tenant**. `AgentStoreProvider.forWorkspace(workspaceId)` makes that easy: the workspace is an
argument, and the adapter turns it into a `WorkspaceScope` before any query.

`RunStore` does not. Its five read/write methods take a run id and nothing else:

```ts
get(runId): Promise<RunRecord | null>;
markRunning(runId): Promise<void>;
finish(runId, status, error): Promise<void>;
append(runId, event): Promise<AppendResult>;
openStream(runId, after): Promise<RunStreamHandle | null>;
```

That is W1-CP-04's design and it is not accidental: `apps/web/server/runs/api.ts` reads the run and
then filters, at lines that today say

```ts
const run = await store.get(runId);
…
return run.workspaceId === principal.workspaceId ? run : null;
```

so the tenant check lives in the route rather than in the store.

Converting the port means changing `api.ts`, `environment.ts`, `launcher.ts` and `relay.ts`, plus
`api.test.ts`, `launcher.test.ts` and `relay.test.ts`. None of the seven is in this task's
ownership globs, and `apps/web/server/runs/api.ts` in particular carries the one end-to-end path
Wave 1 verified in a real browser.

## Decision

**Do not reach for those files. Convert what this task owns, and name the consequence.**

The database run store resolves a run's workspace with one query that is scoped by run id alone —
`findRunWorkspace(db, runId)` in core — and every other query it issues goes through
`RunRepository`, filtered on the scope that query produced.

Three things keep that from becoming a pattern the six Wave 2 tracks copy:

1. `findRunWorkspace` returns a **workspace id and no row content**. No status, no error text, no
   timestamps. Nothing crosses a tenant boundary through it; it tells the adapter which scope to
   build.
2. It is exported and documented in core with a doc comment that opens *"This is the one query in
   the repository layer that is not workspace-scoped"* and says what to imitate instead.
3. An id naming no run answers `null`, and every caller turns that into the same "not found" the
   in-memory store gives — never into an unscoped read
   ([ADR-0015](0015-gates-decide-on-positive-assertions.md)).

The result is memoised per run id, so a request that reads a run and then streams it pays for one
lookup.

## Alternatives considered

* **Declare the seven files under [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md)
  and convert the port properly.** It is the better end state and it was rejected on risk and
  scope, not on principle: seven files, three of them on Wave 1's only proven end-to-end path, in a
  task whose stated acceptance is about agents, one contract suite and one restart. Recorded here as
  the follow-up rather than done badly under time pressure.
* **Keep a `Map<runId, workspaceId>` and answer `null` for anything this process did not create.**
  Rejected: after a restart every run would read as absent, which is exactly the behaviour
  persistence was added to remove, and it would make the durability claim in the start-up log false.
* **Leave the run store in memory.** Rejected by ADR-0024 §2.

## Consequences

* The tenant property is complete *below* the port and incomplete *at* it. That is the honest
  statement, and it is in `apps/web/server/runs/store.ts`'s header, in `findRunWorkspace`'s doc
  comment, and in this task's PR under Declared gaps.
* A later task converting `RunStore` to `forScope` deletes `findRunWorkspace` and its three
  paragraphs of apology. That is the intended end state.
