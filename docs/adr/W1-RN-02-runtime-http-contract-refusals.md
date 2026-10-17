# W1-RN-02 — Every path §14.3 names gets an answer: one run at a time, 501 for what is not built

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-02 (Runner)
Scope: `apps/runner/src/server.ts`; binding on W1-CP-04's relay and on every driver that forwards
`POST /run`

## D1 amendment

The runner's current terminal frame names are `run-done` and `run-error`. The earlier terminal
frame list below records this ADR's initial decision; the current relay and runner implementation
uses the later names.

## Context

Spec §14.3 prints five endpoints and two provider aliases. This task implements three of the five.
Three questions the spec does not answer had to be answered anyway, and each of them is a place a
gate can fail open:

1. **What does a container do with a second `POST /run` while one is running?** §14.3 says
   `POST /interrupt` cancels *"the current run"* — singular — and never describes concurrency.
2. **What does it answer on `/files`, `/invocations` and `/ping`, which the contract names but this
   build does not serve?**
3. **How does a failure inside an established stream reach the client?**

Question 3 is not open: research note R-13 finding 7 probed two independent conformant
clients and both went to `readyState: CLOSED` permanently on a single non-200, with no retry and no
status code on `onerror`. A relay that turns a mid-run failure into a 500 kills the stream for good.

## Decision

**1. One run per container, and the second is refused.** The server holds at most one in-flight run.
A second `POST /run` answers **409** `run_in_flight`, naming the run id already being served. This
is the smallest reading of "the current run": it makes the phrase denote something, it makes
`POST /interrupt` unambiguous, and it matches the §14.4 driver catalogue, where every non-`local`
row is "one container (or one session) per run".

**2. `POST /interrupt` with nothing in flight answers 409, not 200.** Reporting success for an
interrupt that interrupted nothing is the same shape of lie as a gate that passes because it could
not run. The response is `no_run_in_flight`.

**3. Contract paths that are not implemented answer 501, not 404.** `/files` (both methods),
`/invocations` and `/ping` are declared by §14.3, so a 404 would tell a driver it is talking to the
wrong image. 501 with a named reason tells it the truth: this build serves three of five. An
unknown path still answers 404, and its message lists what *is* served. A known path with the wrong
method answers 405 with `Allow`.

**4. The router is a total classifier.** Every arm ends in an explicit answer and the final `else`
rejects and names what it rejected. There is no path through the handler that returns nothing.

**5. Inside an established stream, nothing changes the status code.** By the time the first byte is
written the status is 200 and stays 200. A run ends in exactly one of three named terminal frames:

| Frame | Meaning |
| --- | --- |
| `done` | the event stream ended normally |
| `run-interrupted` | the stream ended after `POST /interrupt`, or after the client disconnected |
| `run-failed` | the stream ended in an error nobody asked for |

None of the three, and no per-event name either, is `error` — HTML §9.2 dispatches an
event whose type is the `event:` field, so `event: error` collides with `EventSource`'s own
transport-error event and is swallowed by the client's watchdog (R-13 finding 7, probed).

**6. Event names come from the classification, not from the SDK's `type` string.**
`sseEventName` is a switch over every arm of `ClassifiedSdkEvent`, ending in `never`. R-01 §4
records that the SDK's type union grows in patch releases; deriving the wire name from that union
would let a future member called `error` reach the wire under a name nobody chose. The SDK's own
`type` and `subtype` are not lost — they travel inside the frame's `data`.

**7. A `RunRequest` that parses but that the SDK boundary refuses answers 422, not 500.** An
absent `tools` or `skills`, or a tenant session scope `claude.ts` rejects, is a bad request; the
refusal message is the caller's to read.

## Alternatives considered

* **Queue a second run instead of refusing it.** Rejected: a queue inside the runtime container is
  state the control plane cannot see, and §14.6 makes the control plane the owner of
  `session → runtime handle`. If two runs must proceed, two runtimes must exist.
* **Allow concurrent runs and make `/interrupt` take a run id.** Rejected as a deviation from a
  PL-0 surface: §14.3 prints `POST /interrupt` with no parameter and calls it "the current run".
  Adding a body shape the spec does not print is exactly the "adding a field the spec did not list"
  failure plan §3.1 names. If Wave 3 finds a driver that needs it, it is a spec amendment.
* **404 for `/files`, `/invocations` and `/ping`.** Rejected: it is indistinguishable from "wrong
  image", which is the diagnosis a driver author would then chase.
* **Return 200 from `POST /interrupt` unconditionally, for idempotence.** Rejected: idempotence is
  a property worth having when the operation *happened*. Here it would report that a run was
  cancelled when there was no run.
* **Name the per-event frames after the SDK's `type` field.** Rejected for the reason in decision 6.

## Consequences

* **A relay must treat 409 on `POST /run` as "provision another runtime", not as a retryable
  error.** W1-CP-04 owns that logic; this ADR is the contract it reads.
* **`202` on `POST /interrupt` means the signal was raised, not that the subprocess has exited.**
  The observable end of a run is its stream ending with `run-interrupted`, and the two are seconds
  apart. The acceptance transcript prints both timestamps, measured against a gateway that *would*
  have answered — after 90 s — so that finishing early distinguishes a cancelled run from a run
  that merely finished. A caller that needs to know the run has stopped waits for the frame, not
  for the 202; `server.ts` does.
* **The 422 arm is defence, not a tested path.** `RunRequest` already refines the tenant session
  scope, and `compileRunRequest` always emits `tools` and `skills`, so no input this task could
  construct reaches it. It is declared unexercised on the PR rather than claimed as covered.
* **Adding `/files` in Wave 3 is a two-line change to the router** — the arm exists, it just answers
  501 today, so the shape of the change is visible before it is made.
