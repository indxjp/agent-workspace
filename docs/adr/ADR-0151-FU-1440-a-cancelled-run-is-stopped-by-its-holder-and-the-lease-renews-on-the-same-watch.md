# ADR-0151-FU-1440 — A cancelled run is stopped by the replica that holds it, and the lease renews on the same watch

Status: proposed (the Owner accepts on merge)
Date: 2026-10-31
Decided by: Agent Portal Phase 1, unit ADR-0151-FU (issue #1440), implementing agent; designs #261
together with the #1440 lease questions, as the Owner decided on #1440 on 2026-10-19
Scope: `apps/web/server/runs/{launcher,interrupt,cancellation-watch}.ts`,
`packages/core/src/db/repositories/runs.ts` (`stopIn`, `markRunning`),
`packages/core/src/db/repositories/runs/queries.ts` (`listStaleRunIds`), issues #261 and #1440

## Context

### What the two issues ask

**#261 (cross-replica interrupt).** `POST /api/runs/:id/interrupt` is a control-plane transition
([SDK-03-RUN-235](SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md)). It writes
`cancelled`, revokes the run's tokens, and then signals the runtime best effort through the
in-process live-run registry in `apps/web/server/runs/interrupt.ts`. When the request lands on a
replica that does not hold the run's stream, the registry has no entry. The run is then cancelled
and its credential is dead, but the runtime child keeps running until `maxRunDurationMs`, and that
compute is wasted. #261 accepts either "a poll-based cancellation column" or "RF-301 run leases".
It requires the invariant _a caller never sees success for a run whose credential is still live_,
and a regression test that interrupts through a replica that does not hold the stream.

**#1440 (ADR-0151 follow-ups).** W3-10 landed the safety-critical slice of
[ADR-0151](0151-a-stopped-run-holds-no-lease-and-run-start-is-idempotent.md) option A. The renewable
lease is still open, and the comment of 2026-10-18 asks six questions about it (Q1–Q6, answered
below). On 2026-10-19 the Owner decided to design the lease, `run_attempts` and per-call
consumption together with #261, "because they depend on what renews the lease and who may change a
run's state, and #261 answers both". This record is that design.

### What main already has (read, not assumed)

- **The stop and the revocation are one commit.** `stopIn` in
  `packages/core/src/db/repositories/runs.ts` takes the run's advisory lock, makes the guarded
  status update, and revokes every live `run_tokens` row in the same transaction. Its comment says
  "a gateway can therefore never observe a committed stopped run whose bearer remains active".
  `RunStore.finish` is first-call-wins over it.
- **The interrupt answers only after that commit.** `interruptRun` in
  `apps/web/server/composition/wiring/run-api.ts` awaits `runs.finish(…, 'cancelled', …)`, then
  `revokeAllRunTokensFor` (browser tokens too), then `signalLiveRun`. `interruptRun` in
  `apps/web/server/runs/api.ts` re-reads the run and only then answers `200`.
- **The queued window is closed.** `markRunning` reports whether this call moved the run out of
  `queued`. A launch for which it returns `false` sends nothing to the runtime. It revokes the token
  it has just minted (`abandonInterruptedLaunch`) and concludes.
- **The launch lives in one closure.** `createRunnerLauncher` (`launcher.ts`) resolves `base` and
  the private runtime headers, registers the live run, calls `markRunning`, arms the
  credential-lifetime timer, posts `/run` and relays the stream. On Vercel the closure is kept alive
  by `keepAlive` (`after()`/`waitUntil`). It releases the live run in its `finally`.
- **The stale sweep** (`stale-sweep.ts`, `listStaleRunIds`) fails `running` rows older than
  `staleRunAfterMs(maxRunDurationMs)` and `queued` rows older than the same bound. It skips
  `awaiting_approval`.
- **Landed for #1440:** #1439, #1543, #1551, #1563, and also per-call consumption (#1541, PR #1555).
  See "Status of the #1440 checklist" below. `run_attempts` (#1565) is closed and parked.
  `runs` has no lease column, no replica id and no attempt row.

### The contradiction this record resolves

ADR-0151's _Interrupt_ bullet says "#261 remains only for live runs, through the attempt row".
There is no attempt row on main: #1565 is parked, and the Owner tied it to this design. If #261
waits for the attempt row, the smallest fix waits for the largest migration. This record narrows the
bullet. It does not reopen it: an attempt row is still where the lease ends up (Q2), but #261 does
not need one.

## Decision

### D1 — The committed terminal status is the cancellation request, and the holder watches for it

No new column is added. A `cancel_requested` flag would say less than the status the interrupt
already commits: the status is durable, every replica reads it, and it is written in the same
transaction that kills the credential. So the run row's stopped status is the durable cancellation
request. Whoever holds the run's launch must notice it and stop the runtime.

1. **The watch.** From the moment `markRunning` returns `true` until the launch's `finally`, the
   launcher runs one per-run watch on an `unref`'d timer. Its interval is
   **`CANCELLATION_WATCH_INTERVAL_MS = 2_000`**. Each tick makes one read of the run's status
   through the existing `RunStore.get`, which `stillRunning` already uses in the capacity retry. It
   is a primary-key lookup by run id and workspace. The port is unchanged. **Read cost:** one
   indexed read per live run per 2 s on the replica holding it, so 100 live runs cost 50 reads per
   second. A batched per-process read (`where id = any($1)`) is the upgrade if that cost shows up,
   and it changes no behaviour. The watch never overlaps itself: a tick that is still waiting on the
   database skips the next one.
2. **What it does.** The launch writes its own stop only in `conclude`, after the watch has stopped.
   So a status the watch reads while it runs that is stopped (`stoppedRunStatuses`: terminal or
   `awaiting_approval`) or missing was written by someone else: an interrupt on any replica, the
   stale sweep, an approval expiry. The watch does the following, once per launch:
   - stops itself;
   - aborts what this process still does for the run: the relay's stream, through an abort
     controller merged into the same `lifetime` signal the run's fetch already carries, and the
     storage write-back, through the existing `onInterrupt` / `interrupted` controller;
   - raises the private `POST {base}/interrupt` through `signalRuntimeInterrupt`, with the same
     5 s bound;
   - lets the launch end through its ordinary `conclude`.

   A second `finish` is a no-op because `finish` is first-call-wins, so the stored status stays the
   one the interrupt wrote (`cancelled`), and `conclude` still releases the sandboxes and reports
   `onRunFinished`. When the interrupt was served on the holding replica, `signalLiveRun` has
   already done the same work. The once-per-launch flag on the handle makes the watch's repeat a
   no-op.

3. **What it does not do.** It never writes a status and never revokes a token. The interrupt has
   already done both. The watch is only how a replica that did not serve the interrupt learns of
   it.

**The invariant is kept by construction.** The interrupt route answers success only after `finish`
has committed, and that commit revoked the run's tokens in the same transaction. Nothing in D1 moves
that ordering or adds a step between them. The watch only acts after the commit, on a run whose
credential is already dead. The `queued` window is unchanged: `markRunning` returning `false` stops
the launch before any credential reaches the runtime. The watch starts only after `markRunning`
returns `true`, so the two paths cover the run's whole life between them. After the interrupt
answers, the runtime stops within one watch interval plus the signal's 5 s bound, or at the
credential lifetime if it cannot be reached. That compute is the only cost, as before. The gateway
refuses every tool and model call from the first commit.

**The regression test #261 requires** goes in `launcher.test.ts` or a sibling. A launch runs
against a fake runtime that holds its stream open. The run is cancelled through the store's
`finish` with no `signalLiveRun` call, which is exactly what a replica without the registry entry
does. With fake timers advanced by one watch interval, the test asserts that:

- the fake runtime received `POST /interrupt` for the run;
- the relay ended;
- the stored status is still `cancelled`, with the interrupt's error text;
- the run's tokens are revoked;
- `onRunFinished` fired once.

A second case asserts that the watch makes no extra signal when the interrupt was served on the
holding replica.

### D2 — The answers to #1440 Q1–Q6 (the lease, designed now, built later)

The lease is designed here so that D1 is its first half and not a detour. Its columns are not built
in this phase (D3).

1. **What renews it.** The D1 watch tick in the launcher process. Once the lease exists, the tick's
   read becomes one guarded update:
   `update runs set lease_expires_at = now() + ttl where id = $1 and lease_token = $2 and status = 'running' returning status`.
   That statement renews the lease and reads the cancellation at the same time: zero rows means the
   run stopped underneath the holder, which is the D1 signal. Neither the runner nor the runner
   manager renews it, and neither do relay frames. A long tool call can be silent for minutes, and
   the runner does not hold the database. On Vercel the launch closure lives as long as its
   `after()`/`keepAlive`. So any process that can drive a run can renew it, and a process that
   cannot renew is one that cannot drive it.
2. **Owner, token, and where it lives.** A random per-claim token (`crypto.randomUUID()`), minted by
   the launcher and set by the same update that moves the run to `running`, as `markRunning` does
   today. No replica id exists, and none is needed: the token proves "the claim I made", which a
   replica id cannot prove after a restart. It is not the attempt id, because there is no attempt
   row. The lease lives on `runs` (`lease_token`, `lease_expires_at`) until `run_attempts` lands,
   then moves to the attempt row through an ordinary expand/contract pair (write both, read the
   attempt, drop the run columns). That is where ADR-0151 puts it. The token is internal: it is
   never rendered and never in a problem envelope (RF-301 "lease tokens internal and redacted").
3. **TTL and cadence.** Renewal every `CANCELLATION_WATCH_INTERVAL_MS` (2 s). TTL is five intervals,
   **10 s**, so one slow tick or a short database stall does not expire a healthy lease. The
   maximum run duration (`maxRunDurationMs`, and `staleRunAfterMs` for the sweep) stays the hard
   bound on every run, leased or not. The lease shortens how long a dead holder's row stays
   `running`. It never lengthens a run.
4. **Lease-guarded transitions.** Only the holder may make the success transitions
   `running → completed` and `running → awaiting_approval`: the guard adds `lease_token = $token`
   to `stopIn`'s `where`. Stopping in the safe direction (`cancelled` or `failed`, by an interrupt,
   the sweep, or an approval expiry) stays unguarded and open to any replica. Requiring the token
   there would break the cross-replica interrupt D1 builds, and a stop that cannot succeed wrongly
   is the direction that needs no guard. So RF-301 step 4's "only the lease holder can transition
   nonterminal state" is read as "only the holder can _succeed_ it". A stale holder whose run was
   stopped finds its `completed` write refused. That write is already a no-op today, because
   `finish` is first-call-wins.
5. **Rows with no lease.** These are `queued` rows; `running` rows written before the migration;
   and rows a previous-revision launcher writes during a rolling deploy, because
   [W1-INF-01](W1-INF-01-migrations-run-in-the-web-entrypoint.md) migrates under the old revision,
   and ADR-0069 says that is the default on Cloud Run, Azure Container Apps and Kubernetes. All of
   them keep today's maximum-duration rule in `listStaleRunIds`. The lease-keyed sweep adds
   `status = 'running' and lease_expires_at < now()` and never replaces the age rule. For the
   success guard to admit a previous-revision launcher, it must match a missing lease
   (`lease_token is not distinct from $token`, with no token passed).
   **Ordering inside the migration:** a previous-revision `stopIn` does not clear the lease. So the
   check "a lease exists only while live" (`lease_token is null or status = 'running'`, with both
   columns null or both set) cannot land in the same release as the columns. Release R adds the
   columns (expand, compatible with the previous revision; no single-revision cutover is needed). Release
   R+1 adds the check after R's stop path has cleared the lease on every stopped row, with a
   backfill that nulls any lease left on a stopped row.
6. **Ordering against RF-301/RF-303.** The lease lands on today's direct launcher first. It does not
   wait for RF-301's `starting` status or RF-303's worker claim. The claim is today's
   `queued → running` update. When RF-303 adds a worker, the worker becomes the holder, and only
   the place that mints the token moves. The sweep keyed on `lease_expires_at` is the stale-lease
   classification of RF-301 step 5. Retry of a pre-execution failure is still RF-303's.

**Per-call consumption is not part of this design, because it has landed.** The #1440 checklist
item "per-call record of approved-call consumption, if the decision path needs which approved call
ran" is met by `runs.consumed_tool_calls` and `consumeApprovedCall` (issue #1541, PR #1555): the
gateway records each approved call in the same update that checks it is approved and not yet used.
Together with `approvals_consumed_at` and `runs_consumed_approvals_never_queued` (#1439), an
approved call runs at most once and a continuation the runner accepted is never retried. The Owner's
2026-10-19 comment listed it as deferred. Main moved on the same day, so this record reports the
current state rather than re-deferring done work.

### D3 — What this phase builds, and what it defers

This phase builds **D1 only, with no migration**. It needs the watch, the once-per-launch handle
flag, the merged abort signal and the regression test. Everything else in D2 is designed here and
deferred. Each deferred item is listed under "Declared gaps" with the trigger that starts it.

## Alternatives considered

- **A `cancel_requested` column polled by the holder** (#261's first shape). Rejected. It needs a
  migration and duplicates a fact the status already holds durably. It also opens a window in which
  the flag is set but the status is not, and the caller would have to be told something about that
  window. The terminal status has no such window, because the credential dies in the same commit.
- **Wait for `run_attempts` and route #261 through it** (ADR-0151's wording). Rejected for this
  phase. #1565 is parked by the Owner's decision and the attempt row is a migration with backfill.
  D1 gives the same user-visible result without it, and the lease moves onto the attempt row later
  (Q2).
- **Build the full lease now: columns, check, sweep and guard.** Rejected for this phase. It needs
  two releases, because of the Q5 ordering, and a rolling-deploy proof. The only production failure
  it fixes beyond D1 is a dead holder's row staying `running` until the maximum-duration sweep. The
  sweep already bounds that, and the credential lifetime bounds the cost. The trigger for it is
  recorded below.
- **Renew from relay frames or the runner manager** (Q1 options). Rejected. Frames stop during a
  long tool call. The runner and the manager do not hold the database and would need a new
  authenticated write path to it.
- **Guard every transition with the lease** (RF-301 step 4 read literally). Rejected. It makes
  the cross-replica interrupt and the sweep impossible without the token. Q4 keeps the safe
  direction open.
- **A Postgres `LISTEN/NOTIFY` push in place of the poll.** Rejected. A transaction-pooled or
  serverless connection (a Vercel function) does not keep a `LISTEN` session open. The
  2 s poll uses the read path every deployment already has.

## Consequences

- ADR-0151's _Interrupt_ bullet is narrowed: #261 is met through the run row's committed status,
  not the attempt row. ADR-0151 and SDK-03-RUN-235 each gain an "Amended by" line. Their decision
  text is unchanged.
- SDK-03-RUN-235's named cross-replica gap closes when D1 is implemented. The runtime stops within
  one watch interval plus the signal bound, not at the end of the credential lifetime.
- The cost is one read per live run every 2 s, made by the replica that holds the run. The upgrade
  to a batched read is recorded above.
- No contract, route, schema or migration changes. The public status set and the SDK are unchanged.
  `cancelled` is the status a cross-replica interrupt already produced.
- Rollback is the revert of the D1 code. No data is written in a new shape.
- `docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md` (RF-301) and the
  roadmap entry "RF-301 Run leases and attempts" point here for what landed and what remains.

## Status of the #1440 checklist

| #1440 item                                                                                                                                   | State    | Evidence                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval consumption and start `Idempotency-Key` that survives a pause                                                                       | done     | PR #1439 (merged 2026-10-18)                                                                                                                                |
| `run_idempotency_conflict` / `invalid_idempotency_key` in contracts; SDK sends `Idempotency-Key`; store parity (review comment 1, items 1–4) | done     | PR #1543 (merged 2026-10-18): `RUN_IDEMPOTENCY_PROBLEM_CODES` in `packages/contracts/src/runs.ts`, `idempotencyKey` in `packages/sdk/src/resources/runs.ts` |
| Unique `continues_run_id`; a separate approval deadline column                                                                               | done     | PR #1551 (merged 2026-10-18): `migrations/0065_run_continuation_and_approval_deadline.sql`, `approvalDeadlineAt` stamped in `stopIn`                        |
| Canonical request hash                                                                                                                       | done     | PR #1563 (merged 2026-10-18)                                                                                                                                |
| Per-call record of approved-call consumption                                                                                                 | done     | Issue #1541, PR #1555 (merged 2026-10-18): `runs.consumed_tool_calls`, `consumeApprovedCall`                                                                |
| `run_attempts` with a `paused` outcome                                                                                                       | deferred | Gap 1 below; #1565 closed and parked                                                                                                                        |
| Lease columns, the live-only check, the lease-keyed sweep                                                                                    | deferred | Gaps 2–4 below; designed in D2                                                                                                                              |

## Declared gaps

These are ready to record on #1440. Each one is a shortcut with a limit and a trigger for upgrading
it.

1. **`run_attempts` with a `paused` outcome** (from the parked #1565). Limit: a run has no attempt
   history, and a retry cannot be told apart from a first execution in the data. Upgrade: when RF-303
   (the recoverable worker) starts, because RF-303 is the first thing that retries. The lease then
   moves from `runs` onto the attempt row by expand/contract (Q2).
2. **Lease columns `lease_token` and `lease_expires_at` on `runs`, the renewing watch update, and
   the holder-only success guard** (Q1–Q4). Limit: a dead holder's `running` row stays open until
   the maximum-duration sweep (`staleRunAfterMs`), not about 10 s. Its credential is bounded by the
   same lifetime, so the cost is compute and a stale `running` badge, not access. Upgrade: on the
   first multi-replica deployment where the maximum-duration sweep is too slow (operator report or
   stale-run metrics), or with RF-303, whichever comes first.
3. **The live-only check constraint** (Q5). Limit: none until gap 2 lands. Upgrade: release R+1
   after gap 2, with the backfill described in Q5.
4. **The lease-keyed sweep** (`lease_expires_at < now()` alongside the age rule). Limit and upgrade:
   as for gap 2. It lands in the same release as the columns.
5. **A batched watch read.** Limit: one read per live run per 2 s. Upgrade: when watch reads show up
   as a measurable share of database load.

## Related decisions

- [ADR-0151](0151-a-stopped-run-holds-no-lease-and-run-start-is-idempotent.md): the lease-only-while-live
  invariant, and the _Interrupt_ bullet that this record narrows.
- [SDK-03-RUN-235](SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md): the interrupt
  ordering and the invariant D1 keeps; its cross-replica gap is the one D1 closes.
- [ADR-0145](0145-a-run-stops-for-approval-or-handoff-and-continues-in-its-session.md) D2.4: the
  approval expiry, a stop in the safe direction that Q4 leaves unguarded.
- [ADR-0069](0069-the-engine-identity-migrations-require-a-single-revision-cutover.md): why the
  live-only check lands one release after the columns (Q5).
- Issues #261, #1440, #1565 (parked), #232 (the tracker SDK-03-RUN-235 named).
