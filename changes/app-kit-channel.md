---
changelog: app
section: Added
---

- Realtime channels (F-11): `channel(name, { resource, key?, retain? })` from
  `@indx-workspace/app/server`, over PostgreSQL `LISTEN/NOTIFY` and one SSE endpoint per channel.
  `publish(tx, { key, type, data })` stores an event in `app_channel_events` and notifies it in the
  same statement, so a rolled-back write is never delivered; `publishEphemeral` only notifies;
  `routes()` is `{ GET }` for `GET /api/channels/<name>/events?key=`, checked against the bound
  resource's `read` access (a refusal is `404` before the stream). The stream resumes from
  `Last-Event-ID` or `?after=`; a stale or future cursor gets `stream-reset`, a malformed one
  `400 invalid_cursor`. One `LISTEN` connection per process reconnects with backoff, and a 1000 ms
  poll covers a missed notification.
- `useChannel(name, key)` and `followChannel` in `./react`: reconnect with `Last-Event-ID`, five
  reconnects in a row without progress, exponential backoff on `retry:` capped at 30 s,
  `Retry-After` honoured, events cleared on `stream-reset`.
- `app_channel_events` (`channelEventLogOf`, `createChannelEventsSql` in `./db`) is created by the
  app template's new third migration `0002_app_kit_channels`; a generated resource's migration is
  now `0003_…` in a new app. `memoryChannelHub` in `./testing` is its in-memory twin.
- The agent panel's stream and the channel streams share one SSE writer.
