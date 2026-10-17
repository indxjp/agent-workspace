# W1-RN-03 — The terminal SSE frame name is decided from `run.interrupted` first, not from the shape of `failure`

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-03 (pre-landing review, blocking finding 1)
Scope: `apps/runner/src/server.ts` (`streamRun`'s terminal-frame name); `apps/runner/src/server.test.ts`

## Context

Pre-landing review flagged `streamRun`'s terminal-frame selection as an instance of ADR-0015's
shape — a gate deciding from the *absence of a negative* instead of a *positive assertion* it
already holds:

```ts
const name = failure === null ? 'run-done' : run.interrupted ? 'run-interrupted' : 'run-error';
```

`run.interrupted` is a fact this code already has, set unconditionally the moment either
`res`'s `close` handler fires or `POST /interrupt` is called (lines 330–336 and 446 of the
pre-fix file). But the expression above only *reads* that fact when `failure` is non-`null` —
i.e. only when `run.connection.events` also threw. `RunnerAgentConnection.events`
(`apps/runner/src/runtime.ts`) is documented as an `AsyncIterable<ClassifiedSdkEvent>` with no
stated obligation to throw on cancellation, and `packages/runtime/src/driver.ts`'s
`AgentConnection<TEvent>` — the interface this type structurally matches — imposes none either:
`interrupt()` is documented there as "cancel the run", not "cause `events` to reject". A
connection whose generator simply returns once its `AbortSignal` fires is therefore conformant,
and for exactly that connection `failure` stays `null` all the way to the terminal frame — so the
old expression reports `run-done` for a run the caller explicitly cancelled.

Reproduced directly against the pre-fix code with a `RunnerAgentConnection` fixture whose
`events` generator awaits its own `AbortController`'s `abort` event and then returns (no throw):

```text
AssertionError: expected [ 'malformed', 'run-done' ] to deeply equal [ 'malformed', 'run-interrupted' ]

- Expected
+ Received

  [
    "malformed",
-   "run-interrupted",
+   "run-done",
  ]
```

(`npx vitest run apps/runner/src/server.test.ts`, the new
`is named \`run-interrupted\` — not \`run-done\` — for a run whose events end cleanly (no throw)
after POST /interrupt` case, run against the pre-fix line above.)

## Decision

Check `run.interrupted` first and unconditionally, before `failure` is considered at all:

```ts
const name = run.interrupted ? 'run-interrupted' : failure === null ? 'run-done' : 'run-error';
```

This is ADR-0015 applied exactly as its own title states it: the terminal name is now read off
the positive fact the run holds (`interrupted: true`, set by the two call sites that already
existed and are untouched by this change), not inferred from whether `failure` happens to be
non-`null`. `failure === null` still distinguishes `run-done` from `run-error` for every run
`run.interrupted` is `false` for — that half of the switch is unchanged in meaning, only in
position.

A permanent regression test is added to `server.test.ts`: `fakeCleanlyCancellingConnection`
builds a `RunnerAgentConnection` whose `events` generator yields once, then awaits its own
`AbortController` and returns cleanly (no throw) once `interrupt()` fires. `runThenInterrupt`
drives it over a real socket — `POST /run`, a short delay so the run is recorded as
`state.current`, `POST /interrupt`, then reads the now-terminating stream to its end — and
asserts the terminal frame is `event: run-interrupted` with `"interrupted":true`, and is never
`run-done`. This is the reviewer's own reproduction, kept in the tree rather than only in this
record: it fails on the pre-fix line (shown above) and passes on the fix.

## Alternatives considered

* **Keep the nested ternary, and instead make every `RunnerAgentConnection` implementation throw
  on cancellation**, so `failure` is always non-`null` when `run.interrupted` is `true`. Rejected:
  it would encode the bug's fix as a *behavioural obligation on every future connection
  implementation* rather than as a property of `streamRun` itself, is not implied by
  `packages/runtime/src/driver.ts`'s documented contract, and the very next conformant connection
  that returns cleanly reintroduces the defect. `streamRun` is the one place that must be correct
  regardless of which shape a connection chooses.
* **A `switch` on `[run.interrupted, failure === null]`.** Considered for explicitness, but a
  two-arm ternary already reads left-to-right as "interrupted, or done, or error" once ordered
  correctly; a four-way switch over two booleans (one combination — interrupted with a failure —
  collapses into the same `run-interrupted` outcome as the other) added a branch with no
  observably different behaviour for no readability gain.

## Consequences

**Every cancelled run now reports `run-interrupted` regardless of how its `AgentConnection`
implementation ends its event stream.** Before this fix, whether a caller's cancelled run was
correctly reported depended on an undocumented implementation detail of the connection it
happened to be running against — `startLocalAgent`'s real connection (`runtime.ts`) forwards
whatever `claude.ts`'s `startRun` does on abort, which was never verified either way; the risk
this closes was live, not hypothetical, for any future driver or for a change to the SDK
boundary's own abort behaviour.

**No consumer-visible change for a run that is not interrupted.** `run-done` and `run-error`
still name exactly what they named before for every run `run.interrupted` is `false` for; this is
a reordering of one condition, not a new outcome.
