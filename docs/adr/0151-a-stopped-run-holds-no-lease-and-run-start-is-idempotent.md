# ADR-0151 — A stopped run holds no lease, and run start is idempotent: decision-ledger item 6 against ADR-0145, and the RF-301 design

Status: accepted — option A (decided by the Owner, 2026-10-18)
Date: 2026-10-18
Decided by: the Owner, 2026-10-18, accepting option A. Drafted for the engineering audit, task W2-11 (finding F-09), tracker #1356; applied by OD-T3
Scope: `docs/architecture/refactoring/claude-agent-workspace-refactoring-decisions.md` (product default 6), `docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md` (RF-301, RF-303, the open-question row on `waiting/suspended`), ADR-0145, `packages/core/src/db/schema/runs.ts`, `packages/core/src/db/repositories/runs*`, `packages/contracts/src/runs.ts`, `packages/engine-claude-agent-sdk/src/boundary.ts`, issues #250 and #261

## Context

### The two records

**Decision-ledger item 6.** The sixth row of "Product defaults" in the
[refactoring decision ledger](../architecture/refactoring/claude-agent-workspace-refactoring-decisions.md)
reads, for "Persisted Run `waiting`/`suspended` state": _"Do not add either state until a runtime
feature requires it."_ Its reason is that a speculative durable state creates transition, recovery
and compatibility obligations with no producer. Its ratification owner is Product + runtime and its
first blocking unit is RF-301. The ledger's own status line says product ratification remains open.
The [refactoring plan](../architecture/refactoring/claude-agent-workspace-refactoring-plan.md)
repeats it as an open question ("Is optional Run `waiting/suspended` needed now?") answered against
"RF-301 schema state list", and RF-301 lists "RF-001 product decision on waiting/suspended" as a
dependency and draws its target machine as requested / queued / starting / running /
(optional waiting) / terminal.

**ADR-0145** (accepted 2026-10-18) adds `awaiting_approval`. D1 says the run **ends** at a gated
tool call — runtime stopped, tokens revoked, sandbox released, usage settled — yet the status is not
terminal: it later moves to `completed` (approved, continued by a new run in the same session) or
`cancelled` (rejected, interrupted, or expired after 24 hours, D2.4). Its Consequences say "the
refactoring-plan row on `waiting/suspended` is met: a runtime feature now requires the state."

### What landed

PR #1348 (P5-2, issue #1299) put the state in the database: core `runStatuses` gains
`awaiting_approval`; `stoppedRunStatuses = terminal ∪ {awaiting_approval}` drives `ended_at` and the
session-busy rule; `runStatusesThatMayMoveTo` allows `running → awaiting_approval` and
`awaiting_approval → completed | cancelled`; the columns `pending_approval` and
`approved_tool_calls` and the check `runs_awaiting_approval_has_pending` exist; the stale-run sweep
deliberately skips paused runs (`listStaleRunIds`). The public contract (`RUN_STATUSES` in
`packages/contracts/src/runs.ts`) does not yet carry it, and the web run store refuses to serve such
a run before P5-4 (#1301).

### The conflict, precisely

1. **The ledger was never amended.** ADR-0145 declares the row met, but the row still says "do not
   add", names RF-301 as the unit that decides the state list, and is unratified. Two records now
   give opposite instructions to whoever implements RF-301 or adds the next state.
2. **The state is of a kind neither record names.** The ledger and RF-301 speak of `waiting` /
   `suspended`, a run that is _live but idle_ (a process, lease or runtime held while something
   external happens). `awaiting_approval` is _stopped but not final_: nothing is held, yet the row is
   not settled. RF-301's machine has no place for that class, so its lease, attempt and idempotency
   rules are undefined for it.
3. **Durable-run guarantees are still missing, and the state was added ahead of them.** There is no
   `RunAttempt`, no launch lease, no idempotency key on start (#250, S-6), no cross-replica interrupt
   (#261); the RF-303 `it.fails` characterisation in `apps/web/server/runs/api.test.ts` still pins
   the fire-and-forget launch. Each further state added before RF-301 widens what RF-301 must
   migrate.
4. **A single-use guarantee is process-local.** ADR-0145 D2.1 makes an approval single-use. The
   Claude adapter enforces it with an in-memory set (`state.consumed` in
   `packages/engine-claude-agent-sdk/src/boundary.ts`). That holds within one process. Once RF-303
   can retry a continuation run in a new process, the approved call could run twice unless
   consumption is durable or the retry is refused as ambiguous.

## Options

### Option A — Ratify `awaiting_approval` as a lease-free stopped state, and keep `waiting`/`suspended` out (recommended)

Amend ledger item 6 to two rules:

- **No live wait is persisted.** `waiting` and `suspended` (a run that holds a process, a lease, a
  runtime or a token while idle) stay unadded, as ADR-0145 D6 also says.
- **A stopped, non-final state may exist only under an accepted ADR that names its exits and its
  deadline, and it holds nothing.** `awaiting_approval` is the first, under ADR-0145. Any later one
  (for example an A2A `input-required`, or a handoff that is not `completed`) needs its own record.

RF-301 then designs its machine around three classes: **pending** (`queued`, and `starting` if it is
added), **live** (`running`), **stopped** (`awaiting_approval`, and the terminal statuses as the
final subset). Consequences:

- **Lease.** A lease (owner, token, `lease_expires_at`) may exist only in the live class (and in
  `starting` once claimed). Moving to `awaiting_approval` clears it in the same guarded update that
  revokes tokens today. The stale sweep keyed on `lease_expires_at` (F-09) therefore never sees a
  paused run, which matches `listStaleRunIds` today without a special case.
- **Attempt.** A `run_attempts` row closes when the run stops, with an outcome `paused`. The
  continuation is a **new run** with its own attempt 1, never attempt 2 of the paused run: the
  attempt counter counts retries of one execution, not decisions.
- **Idempotency on start.** A replay of `POST /api/agents/:id/runs` with the same key and request
  hash returns the original run whatever its status, including `awaiting_approval`; a paused run
  never frees its key. A different request under the same key answers the reserved
  `run_idempotency_conflict`.
- **Idempotency of the continuation.** The continuation is not created by run start, so it needs
  no client key: ADR-0145 D2.3's compare-and-set is its dedupe. RF-301 backs it with a database
  fact — a nullable `continues_run_id` with a unique index — so "exactly one continuation per paused
  run" no longer rests on the conditional update alone.
- **Durable single use.** Consumption of an approved call is recorded durably (on the continuation
  run or its attempt) before the tool executes, and RF-303 treats a continuation attempt that the
  runner accepted as ambiguous: it is not blindly retried (RF-303 step 3).
- **Deadline.** The 24-hour expiry of D2.4 becomes a column the sweep reads (a deadline on the
  pending approval), not a scan of `ended_at`, so it is independent of the lease sweep.
- **Interrupt.** Cancelling a paused run is a plain compare-and-set with no runtime to reach, so it
  already works across replicas; #261 remains only for live runs, through the attempt row.
- **Session-busy.** Busy means "pending or live", which is the stopped/not-stopped split
  `stoppedRunStatuses` already implements.
- **Cost.** One ledger edit; no migration reversal; P5-3 … P5-6 continue unchanged.

### Option B — Uphold item 6 as written, and move the pause out of the run row

The paused run becomes terminal (`completed`, with an outcome naming the approval request), and the
pending decision moves to a separate `run_approvals` row that carries the request, its deadline and
the D2.3 compare-and-set. RF-301's machine keeps only pending, live and terminal statuses.

- **Gains.** The run state machine stays the plan's; lease, attempt and idempotency rules need no
  stopped class; the formal model of runs changes less.
- **Costs.** A reversal of the #1348 migration (forward-only, so a new expand/contract pair), a
  rework of the transition table and of P5-3 … P5-6 in flight, and an amendment of ADR-0145 D1 and
  D2.3–D2.5. A client polling a run sees `completed` for a run that did not do what it was asked,
  unless the API joins the approval row into the run read, which reintroduces the state at the
  edge.
- **Idempotency.** As in A for start and for the continuation (the unique key moves to
  `run_approvals.run_id`); the durable single-use rule is identical.

### Option C — Defer: leave both records as they are until RF-301

- **Gains.** No work now.
- **Costs.** Two records keep contradicting each other; P5-4 (#1301) publishes the status in the
  public contract and P5-5/P5-6 build on it with no rule for leases, attempts or idempotency; any
  next pause-like state lands under the same ambiguity. The roadmap orders this decision before
  W3-10 and before more run states land, so deferring blocks W3-10.

## Recommendation

**Option A.** It matches what ADR-0145 decided and #1348 built, so it costs one ledger edit rather
than a migration reversal. It keeps the ledger's actual concern — no durable state in which
something waits and must be recovered — as a rule, and states it more precisely than "waiting /
suspended". And it gives RF-301 the three invariants it needs to be designed against: a lease only
while live, an attempt per execution with continuations as new runs, and a start key that survives a
pause.

If the Owner accepts A, the acceptance edit is: this record's status becomes accepted; ledger item 6
is rewritten to the two rules above and cites ADR-0145 and this record; the plan's open-question row
and RF-301's "(optional waiting)" and dependency line are updated to match. Those edits are not made
by this record.

## What W3-10 does under each outcome

W3-10 is the roadmap task that implements RF-301/302/303 (attempt, renewable lease, idempotency key)
with the acceptance "the RF-303 `it.fails` flips; a model-based test is green".

| Outcome    | W3-10 scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A accepted | Expand-only migration: `run_attempts` (outcomes include `paused`), lease columns valid only while live (a check constraint), `idempotency_key` + request hash with a unique index scoped to workspace and principal, `continues_run_id` unique, a deadline column for the pending approval. `runStatusesThatMayMoveTo` gains `starting` if RF-301 adds it, and the stop transition clears the lease. Durable consumption of approved calls before execution. The model-based property covers start / retry / crash / sweep / pause / decide / expire and asserts one attempt per key, one continuation per paused run, and no approved call executed twice. |
| B accepted | First a migration pair that moves `pending_approval` into `run_approvals` and makes paused runs terminal, with ADR-0145 amended and the P5 units reworked; then the RF-301 work above without the stopped class. Larger and sequenced behind the P5 units; likely split into two tasks.                                                                                                                                                                                                                                                                                                                                                                     |
| C (none)   | W3-10 does not start: RF-301 has a dependency ("the product decision on waiting/suspended") that is still open, and the roadmap orders this decision first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Consequences

- Accepted as option A. The ledger row and the plan rows named above are amended; no contract, schema
  or code changes with this record. W3-10 implements it.
- Under A or B, the formal model of runs (`docs/formal/domains/d1-runs.md`,
  `tests/formal/contracts-runs.test.ts`) changes with the code that changes the state list, as
  ADR-0145 already requires.

## Related decisions

- [ADR-0145](0145-a-run-stops-for-approval-or-handoff-and-continues-in-its-session.md) — the state
  this record weighs against ledger item 6; D1, D2.1, D2.3–D2.5 and D6.
- [ADR-0121](0121-a-large-evaluation-is-a-run-the-client-advances-under-a-lease.md) — an existing
  client-advanced lease, for comparison with the server-side launch lease RF-301 adds.
- [SDK-03-RUN-235](SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md) — an interrupt is
  a control-plane transition; #261 extends it across replicas.
- Issues #250 (idempotency keys on run start), #261 (cross-replica interrupt), #1299 / PR #1348
  (the `awaiting_approval` status), #1301 (P5-4, public contract).
