# W1-COMP-01 — The runner's own terminal frame collided with the relay's reserved names, so every run reached the control plane as `failed`

Status: accepted
Date: 2026-09-03
Decided by: W1-COMP-01 (the composition root)
Scope: `apps/runner/src/server.ts` (the two terminal frame names); `apps/web/server/runs/relay.ts`
(reads the runner's terminal frame instead of relaying it) and `relay.test.ts`; new file
`apps/runner/src/server.test.ts`. Claimed under
[ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) with the reason below.

## D1 amendment

The earlier `run-interrupted` to failed mapping below was superseded by
[SDK-03-RUN-235](SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md): interrupt now maps
to the run's terminal `cancelled` status.

## Context

This task's mandate is to run the system end to end and report exactly which link does not work.
Doing that — a real `POST /api/agents/:id/runs`, through the real relay, against the real
`apps/runner` — surfaced a defect neither `apps/runner` nor `apps/web` could have found alone,
because neither task's own acceptance run ever drove both halves together:

```text
$ curl -sN http://127.0.0.1:3200/api/runs/964ea169-.../events
event: run.status
data: {"status":"running","error":null}

event: system
data: {"kind":"system","subtype":"init", …}

event: sdk-event
data: {… "content":[{"type":"text","text":"Not logged in · Please run /login"}] …}

event: result
data: {"kind":"result", … "result":"Not logged in · Please run /login" …}

event: run.status
data: {"status":"failed","error":"the event name \"run-failed\" is reserved by the stream
       protocol (done, run-failed, stream-reset, error, run.status) and may not be used by a
       relayed event"}
```

Full transcript on this task's PR. `system` and `sdk-event` and `result` relayed correctly — the
run genuinely reached the SDK and the SDK genuinely answered "not logged in" (no credential is
configured in Wave 1; a separate, already-declared gap). What went wrong is the last line: the
run's true failure reason was replaced by a sentence about the relay's own protocol.

**The cause is two accepted decisions that name the same thing differently.** R-13 (*"Streaming
from Next.js App Router to the browser"*, blocking W1-CP-04 and W1-UI-03) fixes the terminal frame
names for the control plane's **outward** stream, to a browser: `done` on success, `run-failed` on
a failure inside an established 200. `apps/runner/src/server.ts` — a `node:http` server, not a
Next.js route, and not R-13's subject — reused those exact names for its own, different, **inward**
stream: the §14.3 runner-to-control-plane contract. `docs/adr/W1-CP-04-event-names-are-validated-at-ingestion.md`
reserves both names for the control plane's own outward frames and states the binding condition on
the runner in as many words: *"W1-RN-02 must not emit any reserved name from `POST /run` — `error`,
`done`, `run-failed`, `stream-reset` or `run.status`."* `apps/runner/src/server.ts` violated it on
every single run, because `streamRun` sends exactly one of `done` / `run-failed` at the end of
every stream, with no exception.

`apps/web/server/runs/relay.ts` forwards every runner frame into `store.append`, which refuses a
reserved name (correctly — that check exists to stop a tenant's own SDK output from forging a
control frame). The runner's terminal frame is exactly such a forgery from the relay's point of
view, indistinguishable from an attack, so it was rejected every time — turning `relayRunnerStream`
into a function whose "the stream ended cleanly" fallthrough (`return { kind: 'completed', … }`)
was **unreachable** for any real runner response. Every run, success or failure, surfaced at the
control plane as `failed`, carrying the rejection sentence instead of the SDK's own outcome.

**Nothing caught it before this task, because nothing had run both halves together.**
`apps/web/server/runs/acceptance/fake-runner.mjs` — W1-CP-04's own acceptance fixture — never
sends a terminal frame at all; it closes the stream after a `result` frame, which is exactly the
fallthrough path the real bug made unreachable. And `apps/runner/src/server.ts` had no test file
of its own — `streamRun` was never driven by anything, `fake-runner.mjs` included, until this
task's `server.test.ts`.

## Decision

**The runner's terminal frame is renamed `run-done` / `run-error`, keeping `run-interrupted`
unchanged** (it never collided — `RESERVED_EVENT_NAMES` is `done`, `run-failed`, `stream-reset`,
`error`, `run.status`). This is the smaller of the two available repairs: R-13's names govern a
different, already-shipped protocol (the control plane's own outward stream, which
`apps/web/app/api/runs/[id]/events/route.ts` and W1-UI-03's client both depend on by name), and
changing them there would be the larger, riskier edit for a defect that is entirely on the inward
side.

**`apps/web/server/runs/relay.ts` now reads the runner's terminal frame as the run's outcome,
rather than relaying it.** `run-done` → `{ kind: 'completed' }`; `run-error` → `{ kind: 'failed',
reason }`, taking `reason` from the frame's own `message` field — the real SDK failure text, e.g.
*"Not logged in · Please run /login"* — with a named fallback when it is absent; `run-interrupted`
→ `{ kind: 'failed', reason: 'the run was interrupted' }`, which is strictly better than today's
behaviour (silently `completed`, because that name was never reserved and so was never rejected).
None of the three is appended to the store as a relayed event: `apps/web/instrumentation.ts`'s
launcher already writes the platform's own durable `run.status` from whatever `relayRunnerStream`
returns, and appending the runner's raw summary object as well would put a second, differently
shaped opinion about the same outcome into one run's transcript.

**A forged `done` or `run-failed` is still refused.** Those two names are simply no longer ones the
real runner ever sends; `RESERVED_EVENT_NAMES` is untouched, `store.append`'s check is untouched,
and the existing test asserting a forged `event: done` fails the run (`relay.test.ts`, written by
W1-CP-04) is unchanged and still passes — it was testing the defence, which was never the broken
half.

## Why this task edits two other tasks' files

ADR-0018 makes the declared `Owns:` line the boundary provided the globs are disjoint from
siblings, CI passes, and each glob outside the plan's card carries its reason. This is that reason,
and it is the same shape as the launcher/runtime-registry defects this task's other two ADRs
record: a disagreement between two tasks' files — `apps/runner/src/server.ts` (W1-RN-02) and
`apps/web/server/runs/{relay,sse}.ts` (W1-CP-04) — that neither could see, because the collision
only exists once both halves run together, which had never happened until this task did it. Both
branches are frozen several stack positions down; the repair lands above both rather than
restacking either.

The edit is small and precisely bounded: two string literals in `server.ts`, one `Set` membership
check plus a two-line reason-extraction helper in `relay.ts`, and tests. No route, no schema, no
new abstraction — the fix is a rename plus reading a value that was already on the wire.

## Consequences

**Every run in this deployment now reaches the control plane with its true outcome.** Before this
fix, `docker compose logs web` and the run's own event log agreed on nothing useful about *why* a
run ended the way it did; a successful run and a failed one were indistinguishable at the
platform's own `run.status` layer. This is arguably the more load-bearing half of this task's
finding — the wiring gaps the other two ADRs fix make a run *reachable*; this one makes its result
*legible*.

**`run-interrupted` still maps onto `failed`, not a distinct `cancelled` status**, even though
`RunStatus` has one. `RelayOutcome` is `{ completed } | { failed }` and widening it to include
`cancelled` reaches into `launcher.ts`'s dispatch as well — a real improvement, and a larger one
than this task's mandate covers. Declared as a gap on this task's PR rather than taken.

**`apps/runner/src/server.ts` still has no test for anything except its terminal frame name.**
`server.test.ts` is two tests, added to close the specific gap that hid this defect; `/healthz`,
`/interrupt`, the 409 `run_in_flight` concurrency guard and the 400 `invalid_run_request` path
remain untested. Declared, not fixed — this task's mandate is the composition, not a full
regression suite for a sibling's file.

## Alternatives rejected

* **Rename the control plane's outward names instead, to match the runner.** Rejected: R-13's
  contract is the one already shipped to a real consumer (the browser client W1-UI-03 builds), and
  the runner's protocol is the one with zero consumers outside this repository's own control plane.
  The smaller blast radius points at the runner.
* **Prefix every relayed SDK event instead (`sdk.assistant`, …) so no name can ever collide.**
  W1-CP-04's own ADR names this as "a real option" it declined "only because it changes the names
  the UI listens for." Still true here, and a strictly bigger change than renaming two terminal
  names no UI has ever consumed (nothing served a real run before this task).
* **Widen `RESERVED_EVENT_NAMES` to swallow the collision silently — e.g. drop a reserved frame
  instead of failing the run.** Rejected on W1-CP-04's own decision 5: *"A frame the relay cannot
  accept fails the run; it is not skipped."* Doing so would trade a loud, wrong failure for a
  silent, wrong success — worse.
* **Leave it declared and unfixed, like the credential gap.** The difference is reachability: a
  missing provider credential is Wave 4's, stated everywhere in this PR, and cannot be closed here.
  This defect is closed by a same-day rename in a file this task is already the first real caller
  of, and leaving a known, load-bearing bug in place when the fix is four lines is not the honest
  minimum — it is just a bigger declared gap than the fix would have been.
