# W1-CP-04 — A resume cursor has three outcomes, and "missing" is never confused with "malformed"

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-04 (Control Plane)
Scope: `apps/web/server/runs/cursor.ts`, `apps/web/server/runs/store.ts`,
`apps/web/server/runs/api.ts`; binding on W1-UI-03 (the run view's client) and on every later
streaming surface

## Context

R-13 finding 7 fixes the reconnection contract: a browser resends the last `id:` it saw as the
`Last-Event-ID` **request header** on every automatic reconnect, while a manually reconstructed
`EventSource` starts with no id and must pass `?after=`. The server accepts both, header wins, and
both are client-controlled input.

R-13 also fixes an uncomfortable asymmetry: **any non-200 response makes `EventSource` stop
reconnecting forever** (probed for 500, 204 and a wrong `Content-Type`, in Chrome and in undici).
That makes the natural reflex — "reject bad input with a 4xx" — expensive on this one endpoint.

The tempting shape is the one ADR-0015 forbids:

```ts
const after = parseId(header) ?? parseId(query);   // ?? swallows "invalid" into "absent"
```

That is three cases collapsed into two. A client that resumes with a corrupted `Last-Event-ID` is
silently sent the entire log again, renders every event a second time, and never learns why.

A fourth case exists that no amount of parsing can fix: a **well-formed** cursor naming events the
store no longer retains (evicted by the per-run cap), or a cursor **ahead** of anything the run ever
produced. The check runs, the input is valid, and the request still cannot be served as asked.

## Decision

**1. `readResumeCursor` returns one of three arms — `absent`, `after`, `invalid` — and never
degrades one into another.** `absent` means neither the header nor the query parameter was present,
which is a first connection and whose defined meaning is "from the beginning". It is a named case,
not a fallback. An invalid header does **not** fall through to the query parameter.

**2. Parsing is digits *and* range.** `/^\d{1,19}$/` then `<= 9223372036854775807n`. R-13 names this
trap directly: a 19-digit id passes a digit-count check and still overflows the `bigint` column that
has to store it.

**3. A malformed cursor is answered with `400 invalid_resume_cursor`, before the run is looked
up.** Yes, that permanently kills an `EventSource`. It is still the right answer: the client sent a
value this server never issued, so every retry with that value fails identically, and a 200 that
replays the whole log would loop forever *and* corrupt the transcript. Rejecting before the lookup
also stops a malformed-cursor request from being used to probe which run ids exist.

**4. A well-formed but unservable cursor is answered **in band**, with `200` and a
`stream-reset` control frame, then the oldest retained event onward.** The response has not started
when the store reports it, but the client is not at fault and can recover; killing it permanently
would be a punishment for the server's own retention policy. The frame carries `reason` and
`resumedAfter` so the client can discard what it has and re-render, rather than appending
non-contiguous events onto a transcript it believes is complete.

**5. Control frames carry no `id:`.** `done`, `run-failed` and `stream-reset` must not move the
client's resume cursor, so they are written without an id field.

## Alternatives considered

* **`?? `-chain the header and the query, treat anything unparsed as "from the start".** Rejected —
  this is the ADR-0015 bug verbatim, and it fails open into duplicate delivery.
* **Answer 200 and replay everything for a malformed cursor.** Rejected: the client believes it is
  resuming. Duplicates are worse than a stop, because a stop is visible.
* **Answer 400 for an unservable cursor too.** Rejected: the cursor is one this server issued, and
  the client did nothing wrong. Permanently killing its stream because of our retention window is
  the server blaming the client.
* **Silently start from the oldest retained event.** Rejected: it produces a transcript with a hole
  the client cannot see, which is precisely the "renders as complete" failure this programme keeps
  naming.
* **Clamp an out-of-range id to the maximum.** Rejected: clamping invents a cursor the client never
  had.

## Consequences

* A client that corrupts its own `Last-Event-ID` gets a dead `EventSource` and a 400 body naming the
  field. W1-UI-03 must treat `readyState === CLOSED` as "make a new `EventSource` with no cursor",
  which is the behaviour R-13's client sketch already prescribes.
* W1-UI-03 **must** implement a `stream-reset` listener. A client that ignores it will render a
  gapped transcript as a complete one. This is a hard requirement on the UI task, not a suggestion.
* W1-UI-03 **must** implement a `run-failed` listener too, and must not read `done` as success. See
  `docs/adr/W1-CP-04-a-finished-stream-is-not-a-finished-run.md`: `done` means the stream is over,
  and a failed run's stream ends exactly as cleanly as a successful one's.
* The acceptance run exercises the successful path (`Last-Event-ID` → first replayed id is exactly
  `cursor + 1`, no duplicates, no `stream-reset`) through nginx. The `stream-reset` path is covered
  by unit tests over an `InMemoryRunStore` whose retention cap is smaller than the number of events
  the test appends — which is what makes the eviction happen — **not** by the ten-minute run: no
  eviction happens in ten minutes at the acceptance cadence. Declared as such. The caps are in
  `store.test.ts` and `api.test.ts`; they are not restated here, because a number in prose is a
  number that drifts.
