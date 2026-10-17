# ADR-0049 — A session-scoped workspace refuses its own concurrent run, not just its duplicate

**Status:** accepted
**Date:** 2026-09-10
**Scope:** `apps/runner/src/server.ts`
**Context:** P1-3 of the gap review of 2026-09-10; refines
[W1-RN-02](W1-RN-02-runtime-http-contract-refusals.md)'s "one run per container" decision

## Context

`W1-RN-02` decided the runtime container holds **at most one in-flight run**, full stop, and
rejected concurrent runs as a spec deviation: *"if two runs must proceed, two runtimes must
exist."* `86f0bd0` ("bound concurrency and targeted interrupts") replaced that with a
`maxConcurrentRuns` capacity and let any number of distinct run ids execute at once, up to the
configured bound — implementing the gap review's P1-3 recommendation to add capacity-aware
admission, but only half of it. P1-3's own recommended steps say: *"Allocate one isolated Docker
runtime per session/profile on the VM; **serialize only when the same session requires it.**"*
The commit did the first half and skipped the second.

`apps/runner/src/manager.ts` allocates one container per `sessionKey` (`runtimeProfileId:
sessionId`) and reuses it for every run of that session; `RunRequest.cwd` is fixed to
`${workspaceRoot}/${workspaceId}/${sessionId}` (`apps/web/server/compose/run-request.ts:229`),
one directory for the session's entire lifetime, deliberately, so a session's files persist
across its own runs. The consequence: every run id a given container ever serves belongs to the
same session, and two of them in flight together means two SDK processes and two `/files`
hydrate/collect calls against the identical directory, with no lock between them — a code review
against this same gap-review item found the resulting race in `apps/runner/src/server.ts:544`.

## Decision

**A run is refused with `409 session_in_flight` if any run already in flight on this runtime
shares its `sessionId`, independent of `maxConcurrentRuns`.** The capacity bound still applies
across sessions — the shape `86f0bd0` built for a container that could one day serve more than
one session at once — but same-session overlap is refused outright rather than left to race on a
shared `cwd`. This is the "serialize only when the same session requires it" half of P1-3 that the
concurrency commit did not implement.

The check is a linear scan of `state.runs` by `sessionId` in `handleRun`, ahead of the capacity
check: cheap, because a container's active-run count is bounded by `maxConcurrentRuns` (at most
1024), and it must run before capacity admission, not after, so a same-session collision is never
masked by spare capacity.

## Alternatives considered

* **Revert `86f0bd0` to strict one-run-per-container.** Rejected: it undoes the cross-session
  capacity and targeted-interrupt work P1-3 asked for and the commit already built and tested;
  the defect is the missing half, not the whole feature.
* **Give each run its own workspace subdirectory (`cwd` per run, not per session).** Rejected:
  `cwd` is deliberately session-scoped so a session's files persist turn over turn; making it
  per-run would change that product behavior (a session's own runs would stop sharing state
  unless something explicitly re-threads it) to solve a problem that same-session serialization
  already solves without touching the workspace contract at all.
* **Serialize inside `files.ts` (a mutex around hydrate/collect only).** Rejected: it would
  still let two SDK agent processes run concurrently in the same `cwd` between hydrate and
  collect, which is the actual hazard — the `/files` calls are only the boundary, not the run.

## Consequences

* A caller that fires two runs for the same session without waiting for the first now gets an
  explicit `409 session_in_flight` naming the run already in flight, instead of a filesystem race
  that might not surface until the archive is corrupt.
* `maxConcurrentRuns` now means what its doc comment says: capacity *across* sessions. A single
  container still only ever serves one session in the current `manager.ts` allocation model, so
  in practice one runtime still runs one run at a time today — the bound exists for a future
  allocator that packs more than one session's containers together, or shares a runner process
  across sessions, without being a new correctness hazard when that day comes.
