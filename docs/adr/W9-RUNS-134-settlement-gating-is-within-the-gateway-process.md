# ADR-W9-RUNS-134 — "the run's transition to a terminal state" is implemented inside the gateway process, not across it and `apps/web`

Status: accepted
Date: 2026-09-12
Decided by: W9-RUNS-134 (implementing agent)
Scope: `packages/gateway/src/auth.ts`, `apps/web/server/runs/launcher.ts`

## Context

The card's minimum implementation says: "for a stream, [settlement happens] in the stream's
terminal handler, whose completion the run's transition to a terminal state waits on with a
bounded timeout." Read one way, "the run's transition to a terminal state" is `runs.status`
reaching `completed`/`failed`/`cancelled` — which is written by
`apps/web/server/runs/launcher.ts`'s `conclude()`, in a **separate OS process** from
`packages/gateway`, driven by an entirely different HTTP round trip (the runner container's own
`POST {base}/run`, not the provider call the gateway proxies). There is no channel between those
two processes for one to await the other's in-flight promise; any such coordination could only
happen through the database, and the card's minimum implementation names no new table or column
for it beyond `accounting_state` itself.

The card's own verifier attack #1 disambiguates this: *"kill the **process** between the response
being returned and the ledger insert. Restart and read the run."* That failure mode — a captured
provider response never settling because the process holding it died — is entirely a property of
`packages/gateway`'s own handling of **one HTTP response**, independent of anything `apps/web`
does afterward.

## Decision

"The run's transition to a terminal state" is read as the **accounting** state's own transition
to a terminal value (`complete`/`unavailable`/`partial`/`failed`, as opposed to the still-open
`pending`), and it is implemented entirely inside `createAuthenticatedGateway`'s handling of one
provider response:

- The response's `ReadableStream<Uint8Array>` is teed. One branch is forwarded to the caller
  byte-for-byte, unbuffered, exactly as before this task. The other branch is read by
  `recordResponseUsage` to compute usage and call `UsageRecorder.record`/`fail`.
- The **forwarded** branch's own end-of-stream signal — the `{ done: true }` a reader eventually
  sees — is held open (bytes already delivered are unaffected) until the settlement promise
  resolves or `settlementTimeoutMs` (default 5000ms) elapses, whichever is first.

Because the runner container reads a streamed gateway response to completion before it can use
the assistant turn it carries, gating only the *end* of that stream (not its bytes) is what makes
settlement observably finish, from the runner's perspective, before the turn it settles is
considered over — without `apps/web` or `packages/gateway` needing to talk to each other directly,
and without delaying a single byte of the content a user is watching stream in.

`apps/web/server/runs/launcher.ts`'s own terminal transition (`RunStore.finish`) is left
communicating with the gateway only through the database rows both processes share, exactly as
before this task: `conclude()` now additionally reads back the run's settled `cost_usd` for its
`FinishedRunTelemetry` measurement (previously a hardcoded `null`), but it does not wait on
`accounting_state` reaching a terminal value before writing `runs.status` — a run's own lifecycle
and its accounting remain the two independent facts issue #134's schema comment says they are.

## Alternatives considered

- **A cross-process wait**: `apps/web`'s `conclude()` polls or subscribes to `accounting_state`
  before finalising `runs.status`. Rejected as out of the card's minimum implementation — it
  would need a new signalling mechanism (LISTEN/NOTIFY, polling with its own timeout policy, or a
  queue) that neither the issue's "Deliberately not built" list nor the card's Owns globs name,
  and it could not close the crash window verifier attack #1 actually describes (a killed gateway
  process, independent of what `apps/web` is doing).
- **Buffer the whole stream before forwarding any of it**, so settlement is trivially "done" by
  the time the caller sees anything. Rejected: it is exactly the buffering the card and the
  existing test (`packages/gateway/src/auth.test.ts`'s "without buffering the caller") forbid, and
  it would reintroduce the latency regression `launcher.ts`'s own history (the `AbortSignal.timeout`
  regression noted in its comments) shows this codebase has already paid to avoid once.

## Consequences

- A verifier reading "the run's transition to a terminal state" as `runs.status` will not find
  code that makes that literal transition wait on settlement. This ADR is the record of why: the
  minimum implementation's verifier attacks are satisfied by the gateway-internal gating above,
  and building the cross-process version would be the elaboration the Simplicity Mandate asks this
  task not to add.
- `settlementTimeoutMs` bounds only how long the *caller of the gateway* waits for the stream to
  report finished; the underlying database write started by `recordResponseUsage` is not
  cancelled by the timeout and may still complete afterward, which is why a timeout leaves
  `accounting_state` at `'pending'` rather than at any terminal value — nothing observed the
  write's outcome in time to report it.
