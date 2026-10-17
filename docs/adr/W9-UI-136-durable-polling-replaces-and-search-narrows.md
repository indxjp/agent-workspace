# ADR-W9-UI-136 — Active run snapshots are replaced, and text search is explicitly page-local

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-136 (Codex implementing agent)
Scope: `apps/web/components/run/history.ts`, `apps/web/components/run/history-screen.tsx`,
`apps/web/components/run/run-detail-panel.tsx`

## Context

Issue #136 requires live status and usage to reconcile with the durable ledger without double
counting, and asks for searchable, URL-preserved history. The landed `GET /api/runs` contract has
exact filters for status, agent, project, user and date bounds plus an opaque cursor. It has no text
search parameter. This UI task does not own `apps/web/app/api/runs/**` or
`apps/web/server/runs/**`, so adding an unrecognised `q` to the request would either be ignored
silently or require an out-of-partition API change.

The durable API is already the authoritative live snapshot. A second client-side usage accumulator
would create the exact double-counting failure the issue prohibits.

## Decision

1. While a loaded list page contains a queued or running run, the Runs screen polls the same
   `GET /api/runs` URL. While an open detail is queued or running, it polls
   `GET /api/runs/:id`. Each response replaces the complete prior durable snapshot. No number from
   an SSE frame, process-local metric, or earlier response is added to it.
2. `reconcileDurableRun(previous, next)` returns `next` whole. It is a named, pure invariant so a
   test can prove that a change to addition makes the reconciliation test fail.
3. Text search is stored as `?q=` but is labelled **Search this page**. It matches the current
   durable page's run identifiers, status, provider/model and resolved catalogue labels. `q` is
   deliberately not sent to `GET /api/runs`, whose parser does not implement it. Exact filters and
   cursor pagination remain server-side and tenant-scoped.
4. The detail panel exposes durable **Usage** and **Runtime** technical sections. It names the
   accounting state separately from the amount, shows every persisted token counter, and keeps the
   exact UTC timestamp in each `<time>` element's `dateTime`, tooltip and accessible label.

## Alternatives considered

- **Accumulate live counters and merge them into the next durable answer.** Rejected: neither
  source carries a sequence that proves the counters are disjoint, so addition can only guess and
  will double count once settlement lands.
- **Send `q` to the server anyway.** Rejected: a parameter the server does not recognise cannot be
  claimed as history-wide search, and silently ignored input is a failed boundary check.
- **Fetch every cursor page in the browser before searching.** Rejected: it turns one bounded page
  into an unbounded tenant-history download and defeats cursor pagination.

## Consequences

- Live list/detail values converge on the same durable facts a reload and a process restart read.
- Search is honest but page-local. History-wide free-text search remains unbuilt until the durable
  API owns and indexes a search contract; the PR declares this limitation.
- The existing composer `RunView` still renders its event-derived transcript/runtime log. This task
  does not create a second event stream or try to combine those events with ledger counters; the
  durable Usage and Runtime facts live on the deep-linkable Runs detail panel.
