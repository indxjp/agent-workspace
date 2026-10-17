# W1-UI-05 — the browser reads `/api/runs/:id/events` with `fetch`, not `EventSource`

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-05 (UI)
Scope: `apps/web/components/run/live.ts`

## Context

W1-UI-05 needs the home chat to actually consume `GET /api/runs/:id/events` — the SSE endpoint
`server/runs/sse.ts` and `server/runs/api.ts` already implement and serve — so that a real run's
events reach the screen after **Send**. The browser's standard tool for consuming an SSE endpoint is
`EventSource`, and it was the first thing tried.

## Why `EventSource` does not fit this contract

Every frame `server/runs/sse.ts` writes carries an explicit `event:` name — `sseFrame` writes
`event: ${name.name}\n...` for a durable event, `sseControlFrame` writes `event: ${frame.name}\n...`
for a control frame — and there is no code path in that module that omits the field. WHATWG HTML §9.2
dispatches an unnamed frame (no `event:` field at all) to `EventSource.onmessage`; a named frame is
dispatched only to a listener registered for that exact name via `addEventListener`, and there is no
wildcard listener in the API. Since this endpoint never sends an unnamed frame, `onmessage` never
fires, full stop — confirmed by reading `sse.ts` rather than assumed.

The three control frame names (`done`, `run-failed`, `stream-reset`) and the one platform event name
(`run.status`) are fixed and could be bound with four `addEventListener` calls ahead of time. The
relayed SDK events cannot be: `EVENT_NAME_PATTERN` in `sse.ts` is `/^[A-Za-z][A-Za-z0-9._-]{0,63}$/`,
matching whatever the runtime's own event types are — `system.init`, `tool_use.Read`,
`assistant.text`, and (per the real runner's own output, seen in this task's browser walk) names this
repository does not otherwise enumerate anywhere, such as `sdk-event` and `result`. `EventSource`
cannot be told to listen for "everything", so an `EventSource`-based reader would have silently
dropped every relayed SDK event — the entire contents of the SDK events tab behind "Show technical
details" — while still appearing to work, because the four control names it *could* bind would keep
arriving.

## Decision

`apps/web/components/run/live.ts` reads the response body of `fetch(eventsUrl)` as a `ReadableStream`
and parses the (small, already fully specified) SSE wire format by hand: split on the blank-line
frame boundary (`splitSseFrames`), then read `event:`/`id:`/`data:` lines out of each frame
(`parseSseFrame`). Every frame — named or not, known or not — reaches the caller.

This is not a second SSE *implementation* in the sense `server/runs/sse.ts`'s own header warns
against (*"every later streaming surface imports `sseStreamResponse` rather than hand-rolling a
`ReadableStream`"*) — that sentence is about producers, and nothing in `live.ts` writes a frame. It
is the first, and by construction the only, browser-side *consumer* of the format that module writes.

## Alternatives considered

- **`EventSource` with `addEventListener` for the four known names, accepting that relayed SDK events
  are invisible.** Rejected: this deployment has no credential wired in (W1-UI-04, ADR-0021), so a
  run's *own* SDK events were the one part of this task's acceptance bar most at risk of going
  untested by the browser walk — and, once tried, the real runner's stream showed exactly this: a
  `system.init` event, an `assistant` event and a `result` event, none named `run.status`,
  `run-failed`, `stream-reset` or `done`, arriving before the platform's own control frames. An
  `EventSource` reader would have shown none of them, made the SDK events tab look empty, and been
  wrong in a way this task's own manual verification would not have caught without deliberately
  reading the wire format rather than trusting the tab.
- **A library (`eventsource-parser` or similar).** Rejected under §40 and this task's own dependency
  discipline: the wire format this endpoint writes is small and already fully specified by
  `server/runs/sse.ts`'s own module header, parsing it is the "~50 lines of clear TypeScript" §40
  names as the default, and a dependency would need to be added to `apps/web/package.json` — a file
  outside this task's `Owns:` line.

## Evidence

`apps/web/components/run/live.test.ts` asserts `parseSseFrame` and `splitSseFrames` against frames
shaped exactly as `server/runs/sse.ts`'s `sseFrame`/`sseControlFrame`/`sseRetryFrame` write them,
including a frame split across two `fetch` stream chunks. The real-runner browser walk in this task's
pull request description is the end-to-end proof: relayed SDK event names this repository states
nowhere else (`sdk-event`, `result`) reached the SDK events tab, which an `EventSource`-based reader
would not have shown.

## Consequences

- `components/run/live.ts` is now the one place in `apps/web` that reads this wire format from the
  browser. A later streaming surface — the follow-up composer under the run view, when a task wires
  it — reuses `followRunEvents` rather than writing a second reader, for the same reason `sse.ts`
  itself is the one producer.
