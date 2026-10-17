# W1-CP-04 — Event names and payloads are validated where they enter the log, and the names the stream protocol owns are refused

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-04 (Control Plane)
Scope: `apps/web/server/runs/sse.ts`, `apps/web/server/runs/store.ts`,
`apps/web/server/runs/relay.ts`; binding on every later streaming surface and on W1-RN-02

## Context

An SSE frame is line-oriented and has **no escaping**:

```text
event: assistant
id: 41
data: {"text":"…"}
```

The `event:` field ends at the first CR or LF. A name containing a newline therefore terminates the
field, and everything after it is parsed by the client as further fields or as a whole new frame.

The names the control plane writes are not its own. §14.3 has the runtime stream "SDK events", and
R-01 §4 is explicit that the SDK's `type`/`subtype` sets **grow in patch releases** — the correct
handling of an unrecognised type is to forward it opaquely, which `classifySdkEvent` already does.
So the control plane relays attacker-adjacent strings: a name chosen inside a tenant's sandbox,
forwarded verbatim into a frame that another user's browser parses. That is frame injection, and
the injected frame is indistinguishable from a real one.

The same stream also carries **control** frames — `done`, `run-failed`, `stream-reset` — which the
client acts on. A relayed event named `done` would make a browser stop reading a run that is still
going.

The identical argument applies to the one durable event name the **platform itself** writes:
`run.status`, carrying `{ status, error }`. A relayed frame named `run.status` would let a runtime
state its own run's outcome in the run's durable log, where it is replayed to every later reader as
if the control plane had written it. The first revision of this decision reserved only the four
control names and left `run.status` relayable; that was the same mistake in the same list, and it
is corrected below.

And one name must never appear at all. R-13 finding 7: HTML §9.2 dispatches an event whose type is
the `event:` field, so `event: error` lands in `EventSource`'s own transport-error listener, where
the client's watchdog swallows it. R-13 probed this; it is why the failure frame is named
`run-failed`.

Payloads have a smaller, quieter version of the same problem. `JSON.stringify` guarantees the
no-raw-newline rule `data:` needs, but it **throws** on a BigInt and on a cycle, and it **returns
the value `undefined`** — not a string — for `undefined`, a function and a symbol, which would be
interpolated as the literal text `undefined` into a frame a client then tries to `JSON.parse`.

## Decision

**1. Validation happens at ingestion — `RunStore.append` — not at render time.** Everything in the
log is renderable by construction, so `sseFrame` can treat a failure as a broken invariant rather
than as input.

**2. `event:` names must match `/^[A-Za-z][A-Za-z0-9._-]{0,63}$/`.** Deliberately narrower than "no
CR or LF": an allowlist that describes what SDK and platform event types actually look like also
rejects the next injection vector, whereas a denylist only rejects the one that has been thought of.

**3. A relayed event may not use a reserved name.** The reserved set is the union of two lists that
are declared separately because they are reserved for different reasons, and the code derives the
union rather than restating it:

* `CONTROL_FRAME_NAMES` — `done`, `run-failed`, `stream-reset` and `error`, the last of which this
  server never emits at all, for R-13's reason. These are frames, never durable events.
* `PLATFORM_EVENT_NAMES` — the durable events only the control plane writes. `run.status` is the
  member this task has.

`classifyEventName` returns a distinct `reserved` arm so the rejection message can say *why*.

**3a. The reservation is enforced by a second method, not by a flag.** `RunStore.append` is the
relay's only write and refuses every reserved name; `RunStore.appendPlatformEvent` accepts nothing
*but* a platform name (`classifyPlatformEventName` admits a value because it **is** a member of the
list, and rejects everything else). One method with a `trusted` argument would have been a gate that
falls open the first time a caller forgets the argument. The relay's parameter is typed
`RelayTarget = Pick<RunStore, 'append'>`, so the platform method is not merely unused there — it is
not on the type, and reaching for it is a compile error.

**4. `renderEventData` is a two-arm verdict, and both `JSON.stringify` failure modes are handled by
name** — the throw and the `undefined` return. A payload with no JSON representation is rejected
with a message telling the caller to send `null` explicitly if that is what was meant.

**5. A frame the relay cannot accept fails the run; it is not skipped.** `relayRunnerStream` returns
`{ kind: 'failed', reason }` on a rejected append, on a frame whose data is not JSON, and on a frame
with no `event:` name. A skipped frame is a hole in a transcript that will be rendered as if it were
complete — the failure spec §12 and §41 exist to prevent — and it is silent, which is worse than a
failed run.

**6. `sseFrame` still throws on an invalid name or payload.** That is the last line of the defence,
not the first: it means an invariant was broken upstream, and `sseStreamResponse` converts the throw
into an in-band `run-failed` frame rather than a corrupt stream.

## Alternatives considered

* **Sanitise the name (strip newlines) and carry on.** Rejected: two distinct event types can
  sanitise to the same name, and the client cannot tell that anything happened.
* **A denylist of CR, LF and NUL.** Rejected as the weaker form of decision 2 — it is a list of the
  vectors we thought of.
* **Prefix relayed names (`sdk.assistant`) so they can never collide with a control name.** A real
  option, and rejected only because it changes the names the UI listens for, which R-13's client
  sketch and W1-UI-03 both consume. Worth revisiting if the reserved set ever grows.
* **Send unnamed frames and put the type inside `data`.** Rejected: R-13 probed that a `message`
  listener fires for *nothing* a server sends when every frame is named, and mixing named and
  unnamed frames is the one thing its client sketch tells implementers not to do. Naming frames is
  what lets the UI subscribe per type.
* **Drop a malformed frame and continue the run.** Rejected — see decision 5.

## Consequences

* An SDK event type outside the grammar cannot be relayed and fails the run. The grammar covers
  every type and subtype recorded in R-01 §4, including `mcp__server__tool`-style names, but a
  future SDK that emits something exotic would fail loudly rather than inject. That is the intended
  trade and it is a real cost: the failure would be reported as a run failure, not as a
  platform limitation, and whoever hits it should widen the grammar deliberately.
* `RESERVED_EVENT_NAMES` is a compatibility surface. Adding a name to it retroactively rejects
  runtimes that were emitting it; it should only grow alongside a client that understands the new
  control frame.
* W1-RN-02 must not emit any reserved name from `POST /run` — `error`, `done`, `run-failed`,
  `stream-reset` **or** `run.status` — and must name every frame it sends. The authoritative list is
  `RESERVED_EVENT_NAMES` in `apps/web/server/runs/sse.ts`; a frame carrying any of them fails the
  run at ingestion rather than being dropped.
