# ADR-0144 — Inbound triggers start runs from a webhook or a schedule

Status: accepted
Date: 2026-10-18
Decided by: issue #1291 (P4-0 of #1273); accepted by the owner when its PR merges
Scope: the trigger contract in `packages/contracts`, the trigger store and routes in `apps/web`, the schedule sweep (pattern: `apps/web/server/runs/stale-sweep.ts`, `apps/web/server/sessions/retention-cron.ts`), `apps/web/package.json` (`croner`), `pnpm-lock.yaml`
Related: ADR-0065 (the run lifecycle, not amended: a firing starts a run through the same path as a session turn); ADR-0134 (endpoint clients: the hashed, show-once credential shape and its revocation); spec §22 (API keys: the secret is shown once); W2-CP-02 (envelope encryption, reused for `zoomSecretToken`)

## Context

Nothing in Agent Workspace starts a run on an event. Probe `inbound-trigger`
(`tests/gallery/harness/probes.ts`) looks for a `trigger|webhook|schedule|cron` route in
`API_ROUTES` (`packages/contracts/src/routes.ts`) and finds none. Four gallery use cases record
that as a gap: customer-inquiry, excel-consolidation, meeting-minutes (a Microsoft Graph or Zoom
webhook) and ringi-review (each `benchmark.ts`, `ref: 'inbound-trigger'`).
`tests/gallery/ringi-review/backend/on-ringi-submitted.ts` is today's workaround: the customer hosts
the endpoint and dedupes in a store of their own, because a retried webhook would otherwise start a
second, billed run.

This is the opposite direction from roadmap N-3 (#250), which sends run outcomes out. It is also
separate from #250 S-6, an `Idempotency-Key` on `runs.start` (probe `run-start-idempotency`), which
is not built.

The scheduling half has a pattern to copy. `stale-sweep.ts` takes a named lease with
`lease.tryAcquire(name, ttl)`, releases it in `finally` and runs on an unref'd `setInterval`.
`retention-cron.ts` (`wireSessionRetention`) runs a cron route where `CRON_SECRET` is set and the
interval everywhere else, never both, and its header notes that Vercel may deliver a cron twice. The
lease is `tryAcquireMaintenanceLease` in `packages/core/src/db/repositories/root.ts`.

Cron expressions are not 50 lines of clear TypeScript (§40): ranges, steps, names, day-of-month with
day-of-week, time zones and daylight-saving jumps. `croner@10.0.1` is already in `pnpm-lock.yaml`,
pulled in by `@mastra/core`. No workspace package depends on it directly.

## Decision

- **D1 Trigger resource.** A `Trigger` belongs to a workspace and targets one agent. Its `kind` is
  `webhook` or `schedule`. It carries a `prompt` template whose only substitution is `{{body}}`: the
  raw request body for a webhook, the empty string for a schedule. Any other `{{…}}` is refused when
  the trigger is created (a validation error), never left in the prompt as literal text. A schedule
  also carries `cron` (five fields) and an IANA `timezone`, both validated with croner at creation.
- **D2 One-time secret.** A webhook trigger's URL secret is minted at creation, shown once, stored
  only as a SHA-256 hash, compared in constant time and rotated by `POST …/secret`. It has the same
  shape as spec §22 and ADR-0134. A schedule trigger has no secret. The URL secret is the whole
  authentication of the ingress: it is not a session, and it proves nothing about permission (D3).
  - **Where the secret travels.** In the URL path (`/api/triggers/{id}/{secret}`), never a query
    parameter or a header: Microsoft Graph and Zoom can only call a fixed URL. The request logger,
    traces and audit records redact the secret segment and record the trigger id only.
  - **One answer for every miss.** An unknown, deleted, disabled or revoked trigger and a wrong
    secret answer the same status, error code and body, so a caller cannot learn whether a trigger
    exists. The hash is compared with `crypto.timingSafeEqual`, against a dummy hash when no trigger
    is found.
  - **Limits, so a leaked URL cannot start unlimited billed runs.** Each is checked after the secret
    verifies, so a caller without the secret can neither probe them nor use up the trigger's budget.
    1. Body: at most 256 KiB (`TRIGGER_MAX_BODY_BYTES`), refused with `413`. It is enforced while
       the body streams in, before it is read whole (`apps/web/server/http/json-transport.ts`).
    2. Rate: at most 30 firings a minute per trigger (`TRIGGER_RATE_PER_MINUTE`), refused with `429`
       and `Retry-After`. It reuses `perMinuteLimiter` (`apps/web/server/http/rate-limit.ts`), which
       is per process, so it bounds the rate per replica.
    3. Concurrency: at most 3 unfinished runs per trigger (`TRIGGER_MAX_CONCURRENT_RUNS`), refused
       with `429` and `Retry-After`. It is counted in PostgreSQL in the firing path, before the run
       starts, so the cap holds across replicas.
- **D3 Owner principal.** A trigger stores the `workspace_principals` id that created it. Every firing
  starts the run as that principal and checks RBAC again at that moment, because identity is not
  permission. If the principal is revoked (an API key's `revoked_at`), removed or no longer allowed,
  the firing is refused with a stable error code and starts nothing. The trigger stays; it is not
  deleted silently, so its owner or an admin can see it and reassign it.
- **D4 Dedupe.** An optional `Idempotency-Key` header is unique per `(trigger_id, key)` for 24 hours.
  A repeat answers with the first firing's run id and starts nothing. The window is a named
  constant that P4-1 pins in a test. Replay protection in scope is exactly this: a retried or
  replayed delivery within 24 hours starts nothing. Signed timestamps and per-provider signatures
  are deliberately out of scope, because each provider has its own scheme and clock-skew rule
  (see D7 and the alternatives), and the URL secret and its rotation already bound a leaked URL.
  The key is local to triggers; it neither depends on #250 S-6 nor
  pre-empts it.
- **D5 Scheduling.** A sweep finds due schedule triggers under a maintenance lease, in the shape of
  `stale-sweep.ts`, and is wired like `wireSessionRetention` (cron route when `CRON_SECRET` is set,
  in-process interval otherwise). It records `last_fired_at`. A missed window fires once on
  catch-up, never once per missed tick. Before a run starts, each firing claims the
  `(trigger_id, scheduled_at)` slot, so a duplicate Vercel delivery or a second replica is harmless.
- **D6 `croner` is a direct dependency** of `apps/web`, the package that owns the sweep, pinned
  exactly at 10.0.1 (the version in the lockfile). Cron parsing and next-fire computation call it;
  nothing else in the codebase parses cron.
- **D7 Provider handshakes in scope.** Two, and no more. Microsoft Graph's `validationToken` query
  parameter is echoed as `text/plain` with status 200 and starts no run. Zoom's
  `endpoint.url_validation` event is answered with `plainToken` and its HMAC-SHA256 `encryptedToken`.
  That needs the Zoom app's secret token, so a webhook trigger may carry an optional, write-only
  `zoomSecretToken`, stored under the envelope encryption of W2-CP-02 and never returned. It is used
  for this handshake and for nothing else. Both handshakes are answered only after the D2 URL
  secret verifies; an invalid secret gets the same response as any other miss. There are **no per-provider signature schemes**: the URL
  secret from D2 is the authentication.
- **D8 Not built.** Event filters, JSONPath or any payload-to-field mapping, and retry queues. A
  failed firing is a refused request the sender may retry with the same `Idempotency-Key`.

## Alternatives considered

- **Hand-written cron parsing.** Rejected. Time zones, daylight-saving jumps and day-of-month with
  day-of-week are the parts that go wrong, and the library is already installed.
- **A template language or JSONPath mapping.** Rejected. It is the issue's "do not build" list, and
  `{{body}}` hands the model the whole payload, which it reads better than a mapping can select.
- **Per-provider signature verification.** Rejected. Each scheme (Graph, Zoom, GitHub, Slack) is its
  own secret, header, clock-skew rule and test matrix. The URL secret authenticates, and rotation
  revokes it.
- **A separate queue or worker service for schedules.** Rejected. The maintenance lease already
  gives one sweeper at a time, and a missed window is a catch-up, not a backlog.
- **Firing as a synthetic "trigger" principal.** Rejected. It would sit outside revocation and RBAC,
  so removing a person would not stop their triggers.
- **Reusing the #250 S-6 run-level key.** Rejected for now. It is not built, and using it would make
  this work wait for #250. A later run-level key can sit in front of the trigger key without
  changing D4.

## Consequences

- A new public resource, and a new ingress that no session authenticates: the URL secret does. Its
  failures are the stable `4xx` codes of D3 and D4, and infrastructure failures stay `5xx` without
  leaking SQL or provider text.
- A new direct dependency, `croner` 10.0.1 in `apps/web`. Reversing D6 means replacing the croner
  calls only; the stored `cron` and `timezone` fields do not change.
- A trigger outlives its owner but refuses to fire until it is reassigned.
- `last_fired_at` and the `(trigger_id, scheduled_at)` claim are new persisted state, so P4-1 ships
  a migration and PostgreSQL-backed tests.
- Open items P4-1 may amend, each with the default above: the 24-hour dedupe window (D4), catch-up
  fires once (D5), and the optional `zoomSecretToken` (D7).
- Signatures, event filters, payload mapping and retries each need a new ADR.

## Amendment — the key without a header, pruning and the catch-up base (issue #1576, 2026-10-19)

- **D4.** A delivery without an `Idempotency-Key` is keyed `body:<SHA-256 hex of the body>`, so a
  Microsoft Graph or Zoom retry of the same notification (neither sends the header) starts one run.
  An explicit header still wins. An empty body has nothing to tell a retry from a new firing and
  gets a fresh key, as before. A sender that wants two runs from one body sends two keys.
- **D4.** The schedule pass also deletes each workspace's deliveries older than the window, except
  one whose run is still unfinished, which the concurrency cap counts.
- **D5.** Counting restarts when a schedule is enabled again or its cron or time zone changes
  (`triggers.schedule_from`). A missed window still fires once on catch-up, but a window that passed
  while the trigger was disabled, or under its old schedule, is not owed.
