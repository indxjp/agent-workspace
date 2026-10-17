# ADR-W1-INF-03b — `killTree` signals the whole POSIX process group, not just the spawned child

Status: accepted
Date: 2026-09-04
Decided by: W1-INF-03b, Infra agent
Scope: `tests/auth.test.ts` (`killTree`, the `next dev` spawn in the composition-root describe block)

## Context

Pre-landing review of `tests/auth.test.ts:801-812` found `killTree()` correctly recursive on
win32 (`taskkill /pid <pid> /T /F` walks the process tree by parent pid) but not on POSIX, where
it called only `child.kill('SIGKILL')` — a signal to the direct child alone.

That is not "close enough" on this codebase. `next dev` under Next 16 with Turbopack forks a
`next-server` OS process that is a **grandchild** of the spawned process, not a child of it.
`child.kill('SIGKILL')` never reaches it. Reproduced in `node:24-bookworm-slim` (matching CI's
`ubuntu-latest`), against the pre-fix commit (`b9af83d`):

* Run 1 of `pnpm test` passes (663 tests), and leaves a `next-server` process alive with
  `PPID 1` — reparented to init, `ps -eo pid,ppid,stat,cmd` confirms it survived `afterAll`.
* Runs 2 through 5, on the same container with that orphan still resident, each report
  `1 failed | 33 passed` at the file level and **`597 passed | 66 skipped`** at the test level,
  every one timing out at ~181s (the suite's `STARTUP_TIMEOUT_MS`) because the new `next dev`
  process never answers its startup probe — exactly the shape the review predicted: a later
  invocation on the same machine hangs behind a resource an earlier, supposedly-finished run
  never released.

The standard fix for "a spawned process forks its own children and the parent needs to reap all
of them" is to make the spawned child a POSIX process-group leader and signal the group, not the
one pid: `spawn(..., { detached: true })`, then `process.kill(-child.pid, 'SIGKILL')`. The
negative pid is what tells `kill(2)` to target the group rather than a single process. win32 has
no equivalent of process groups in this sense, and does not need one — `taskkill /T` was already
correct there, which the review confirmed and this change leaves untouched.

## Decision

* Spawn `next dev` with `detached: process.platform !== 'win32'`, making `child.pid` the process
  group leader on POSIX so every descendant it forks — `next-server` included — inherits that
  group.
* On POSIX, `killTree` now calls `process.kill(-child.pid, 'SIGKILL')` inside a `try`, falling
  back to `child.kill('SIGKILL')` on failure (e.g. the group is already gone) so a signal that
  cannot be delivered never throws out of `afterAll`.
* win32 is unchanged: still `taskkill /pid <pid> /T /F`, falling back to `child.kill('SIGKILL')`.

## Alternatives considered

* **Track and kill the `next-server` pid directly**, parsed from `next dev`'s own output or
  `/proc`. Rejected: fragile against a version bump in what `next dev` prints, and it does not
  generalise — the next tool this suite spawns that forks its own children would need the same
  bespoke tracking again. A process-group kill is the general answer to "the child forks", not a
  Next-specific patch.
* **`tree-kill` (npm package)**, which walks `/proc` on Linux to find descendants by parent pid
  and signals each. Rejected under spec §40: this is exactly the "50 lines or fewer" case — a
  built-in process-group signal already exists in `node:child_process`/`node:process` and needs
  no dependency, no `/proc` parsing, and no added supply-chain surface for a test-only helper.
* **Leave win32 as `taskkill /T` but ALSO add `detached: true` there.** Rejected: on win32,
  `detached: true` changes console-signal behaviour (the child stops receiving Ctrl+C from the
  parent's console) and buys nothing for `taskkill /T`, which already walks by parent pid
  regardless of process-group membership. Scoping `detached` to non-win32 keeps the working
  win32 path exactly as it was, per the review's own finding that only POSIX was broken.

## Consequences

A `next-server` grandchild is now killed with the rest of the tree in every `afterAll`, verified
by `ps -eo pid,ppid,cmd` showing no `next-server` process survives a run (see the PR body's
Appendix B evidence: five consecutive `pnpm test` runs against a real PostgreSQL 17, in
`node:24-bookworm-slim`, all five totals identical, with `ps` after each run showing no orphan).

This is scoped to POSIX process groups; it does not generalise to a container-per-child model or
to a process that daemonizes itself out of its group (double-fork past group membership). No
process in this suite does that today. If a future spawn target does, this ADR's group-kill
stops being sufficient and needs re-deciding then — it is not silently assumed to still work.
