# W1-CP-04 — A stream that ended is not a run that succeeded

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-04 (Control Plane)
Scope: `apps/web/server/runs/sse.ts`, `apps/web/server/runs/api.ts`; binding on W1-UI-03 (the run
view's client) and on every later streaming surface that copies `sseStreamResponse`

## Context

This record exists because the first revision of this task shipped the opposite of what its own
documentation claimed, and the claim is the more dangerous half.

`sse.ts` reserved a frame name `run-failed` and described it as "the run failed inside a 200
response". The PR body said a mid-run failure "travels in band as a `run-failed` frame". Neither
was true. The frame was written from exactly one place — the `.catch()` on the producer — so it
fired when *producing the stream* threw, and never when the *run* failed. A run whose runtime was
unreachable produced this, reproduced by execution:

```
retry: 3000

event: run.status
id: 1
data: {"status":"running","error":null}

event: run.status
id: 2
data: {"status":"failed","error":"POST http://runner.invalid/run failed: getaddrinfo ENOTFOUND"}

event: done
data: {}
```

`event: done` — the frame R-13's client sketch closes the `EventSource` on — and no `run-failed`
anywhere. A W1-UI-03 author reading the reserved-name list would have registered a `run-failed`
listener, never seen it fire, and rendered a failed run as a completed one. The failure is not that
`done` is wrong; `done` correctly says the stream is over. The failure is that nothing said what
happened to the *run*, and "the stream ended cleanly" is exactly what a client reads as success.

The two facts are genuinely different. A stream ends when this connection has nothing more to
deliver. A run ends when its record reaches a terminal status. They coincide on the happy path,
which is why conflating them survives every test written on the happy path.

## Decision

**1. `sseStreamResponse` requires its caller to state the run's outcome.** The option is
`outcome: () => Promise<StreamOutcome>` and it is **not optional**. A caller that does not say how
the run ended cannot inherit "it went fine" by omission — which is the default this task already
shipped once. Every later streaming surface that copies this module has to answer the question.

**2. `StreamOutcome` has three arms and only one of them is silent.**

| arm | frames written, in order |
| --- | --- |
| `succeeded` | `done` |
| `failed` (status, message) | `run-failed` `{status, message}`, then `done` |
| `indeterminate` (reason) | `run-failed` `{status: "unknown", message}`, then `done` |

`run-failed` precedes `done` in both failing arms, so a client that closes on `done` has already
been told. Its payload is always `{ status, message }`: `status` is the run's own terminal status,
or the literal `"unknown"` when this connection could not determine one.

**3. The classifier that reaches `succeeded` requires a positive `completed`.** `classifyRunOutcome`
switches over `RunStatus`: `completed` → `succeeded`; `failed` and `cancelled` → `failed`, carrying
the run record's own `error`; `queued` and `running` → `indeterminate`, because the stream ended
before the run did and this connection knows nothing; a record that cannot be read → `indeterminate`;
and a `default` arm that reports an unrecognised status rather than falling through. There is no
input for which it answers `succeeded` without having read the string `completed` (ADR-0015). A test
drives it from `runStatuses` and asserts the set of statuses that yield `succeeded` is exactly
`['completed']`, so a status added to the lifecycle and not to the classifier fails there.

**4. The producer's `.catch()` keeps `run-failed`, with `status: "unknown"`, and writes no `done`.**
A stream that broke while producing frames knows nothing about the run's outcome; claiming `failed`
would be as wrong as claiming success. And it must not write `done`, because telling a client to
stop reconnecting is a claim that nothing more will ever arrive — which this server cannot make
about a run that may well still be executing. Reconnecting with `Last-Event-ID` is the right client
behaviour here, and it is available because the run's log is durable past the connection.

**5. The durable `run.status` event stays.** It is not redundant with the control frame: it is
replayable, so a client that reconnects after the fact learns the outcome from the log rather than
from having been connected at the right moment. The control frame is what a client watching *now*
reacts to; the event is what the transcript remembers. Both are written; neither is inferred from
the other.

## Alternatives considered

* **Fix the comment and the PR sentence, leave the behaviour.** This is what the verification round
  proposed, and it is a smaller change. Rejected: it leaves a reserved frame name whose documented
  meaning is "the run failed" and which never fires when a run fails, and it makes every client
  responsible for a second request to `GET /api/runs/:id` to learn something the stream was already
  in a position to say. Documenting a trap is worse than removing it when removing it is this small.
* **Emit `run-failed` *instead of* `done` for a failed run.** Rejected: R-13's client sketch closes
  the `EventSource` on `done`, so a failed run would leave the connection open and the browser would
  reconnect, replay and see the same frame again — the exact loop R-13 finding 7 records for
  `event: error`. `done` means "stop"; it must be sent whenever stopping is correct.
* **A new control name (`run-cancelled`, `stream-failed`) per outcome.** Rejected: the reserved set
  is a compatibility surface (see the ingestion ADR), every new name is a name a runtime may already
  be using, and the distinction fits in the payload the client is already parsing.
* **Make `outcome` optional, defaulting to `succeeded`.** Rejected as the defect restated: a caller
  that forgets it gets the wrong answer silently. Required is a compile error.

## Consequences

* **W1-UI-03 must listen for `run-failed` and must not treat `done` as success.** `done` means the
  stream is over. The run's outcome is `run-failed` (if it arrives before `done`), or the last
  `run.status` event in the log, or `GET /api/runs/:id`. All three agree; the first is the one that
  needs no extra request.
* `run-failed` now carries `{status, message}` rather than `{message}`. Nothing consumes the old
  shape yet — W1-UI-03 has not been written — so this is a change to an unreleased contract, and it
  is stated here rather than left for a reader to diff.
* Every caller of `sseStreamResponse` must supply `outcome`. There is one today (`streamRunEvents`);
  the requirement exists for the ones that are not written yet.
* `classifyRunOutcome` re-reads the run record through `findRunForPrincipal`, after the source is
  exhausted, rather than closing over the record fetched before the stream started — that copy still
  says `queued`. The workspace check is repeated deliberately, so an outcome frame can never
  describe another workspace's run (spec §25).
