# ADR-SDK-18-N3-250 — Run-outcome webhooks are signed Standard-Webhooks deliveries from a PostgreSQL outbox

Status: accepted
Date: 2026-10-31
Decided by: SDK-18-a (issue #250, Agent Portal Phase 1) implementing agent
Scope: the N-3 row of `docs/sdk/04-api-specification.md` §8 and its §5.17; the `webhooks` resource
that later #250 units build in `packages/contracts/src/webhooks.ts`, `packages/core/src/db/schema/**`
and `packages/core/src/db/repositories/{runs,webhooks}.ts`, `apps/web/server/webhooks/**`,
`apps/web/app/api/webhooks/**`, `apps/web/server/rbac/permissions.ts`,
`packages/sdk/src/resources/webhooks.ts`, `packages/sdk/src/webhooks/verify.ts` and
`packages/aw/src/commands/webhooks.ts`

## Context

Issue #250 (SDK-18) item **N-3**: _"Today: a backend learns that a run finished by following or
polling. Target: a workspace registers an endpoint and receives signed `run.completed` /
`run.failed` / `run.cancelled` events with status, usage and cost, retried with backoff,
deduplicated by run id."_ Its scope makes N-3 a §8 row _"with the signature scheme, retry policy and
the event schema as the first commit"_, and names the rest: `WebhookEndpointSchema`,
`WebhookEventSchema` (the signed envelope), the problem codes, the registry at `/api/webhooks`, a
delivery worker with backoff and dedup, the RBAC row (Owner/Admin MANAGE),
`webhooks.create|list|remove`, a `verifyWebhookSignature` helper, and `aw webhooks *`. The acceptance
is: _"A receiver that answers `500` gets the event again with backoff, and exactly once after it
answers `200`; the signature verifies with the helper and fails with a wrong secret."_

N-3 is a new platform table, route and behaviour, so the repository rule is that this record and
the specification amendment land before any of them. What main already has, and what this record
reuses rather than re-decides:

- **Where a run stops.** Every move to a status at which the runtime is over (terminal, or
  `awaiting_approval`) is one guarded transaction, `stopIn` in
  `packages/core/src/db/repositories/runs.ts`: the guarded status update, the optional `run.status`
  event and the revocation of the run's tokens commit together. Finish, interrupt, the stale-run
  sweep and the approval decisions all take it. `RunStore.finish` is first-call-wins, so a run
  reaches a terminal status once.
- **Paused runs (ADR-0151, ADR-0145).** `awaiting_approval` is a _stopped, non-final_ state. It
  later moves to `completed` (approved, continued by a new run in the same session) or `cancelled`
  (rejected, interrupted or expired).
- **Background work without a new service.** `apps/web/server/runs/stale-sweep.ts` runs on an
  in-process unref'd timer under a named maintenance lease
  (`RepositoryRoot.tryAcquireMaintenanceLease`, a PostgreSQL session advisory lock), so one replica
  sweeps per tick. The trigger schedule pass (ADR-0144 D5) uses the same shape. Its declared limit
  is that a serverless instance sweeps only while warm.
- **A secret the platform must use, not just compare.** A trigger's optional `zoomSecretToken`
  (ADR-0144 D7) is stored through `SecretsService` under a derived secret name
  (`apps/web/server/triggers/store.ts`, `TRIGGER_<ID>_ZOOM_TOKEN`) with the envelope encryption of
  W2-CP-02, and it is never returned.
- **Outbound HTTP.** `packages/core/src/net/egress-policy.ts` (ADR
  [W9-PROV-127](W9-PROV-127-egress-policy-design.md)) is the repository's one egress rule for
  server-side fetches to a URL a tenant supplied. `checkEgress` resolves the host and refuses
  loopback, RFC 1918, RFC 6598, link-local, unique-local, IPv4-mapped and cloud-metadata addresses
  unless the exact host is on `EGRESS_ALLOW_HOSTS`. It refuses userinfo and requires HTTPS, except
  that a non-production posture tolerates a loopback HTTP target. `guardedFetch` sends with
  `redirect: 'error'` and pins the checked address for `http:` targets. No other egress or SSRF
  guard exists for outbound URLs (`apps/web/server/models/probe.ts` and the gateway providers
  already call it). The sandbox egress proxy (ADR-0117) governs agent code, not the platform.
- **Feature ids (ADR-0160 D1)** are a closed enum, and run-adjacent routes such as triggers and
  evaluations depend on `runs`.
- **Four names (ADR-0114).** One concept has one name across contract, route, SDK and CLI.

The portal implementation guide (§7.2) calls the helper `verifyWebhook`.
The issue names it `verifyWebhookSignature`, and the issue wins over the guide.

## Decision

**D1 Resource.** A workspace-scoped **webhook** is an endpoint the platform posts run outcomes to:
`{ id, workspaceId, url, events, createdAt }`. `events` is a non-empty set of
`run.completed | run.failed | run.cancelled`, and all three when omitted at create. A workspace
holds at most **10** webhooks, which bounds the fan-out of one run's stop and keeps the list
unpaginated (§4 of the specification). There is no update: a change is a remove and a create. The
**signing secret** is minted at create as `whsec_` followed by the base64 encoding of 32 random
bytes. It is returned once, in the create answer (`201 { webhook, secret }`), the show-once shape of
ADR-0144 D2 and spec §22, and never again. It cannot be hashed like a trigger's URL secret, because
the platform must sign with it. It is therefore stored through `SecretsService` under the derived
name `WEBHOOK_<ID without dashes, upper-case>_SIGNING_SECRET`, following the Zoom-token precedent, and
removed with the webhook. A deployment with no secrets service cannot store it, so the routes there
answer `503 webhook_api_not_configured`.

**D2 Signature scheme: Standard Webhooks v1.** Each attempt is a `POST` with
`Content-Type: application/json` and three headers:

- `webhook-id`: the event id (D3), the same on every retry of one delivery.
- `webhook-timestamp`: the attempt time in integer Unix seconds, fresh on every attempt.
- `webhook-signature`: `v1,<base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<body>"))>`,
  where `key` is the base64-decoded part of the secret after `whsec_` and `body` is the exact
  request body bytes.

The header is a space-separated list, so a later secret rotation can sign with two keys without a
new scheme. A receiver accepts the request when any `v1` entry matches, compared in constant time,
and the timestamp is within **±5 minutes** of its clock. The SDK helper is
`verifyWebhookSignature({ secret, headers, body, toleranceSeconds = 300, now? })`. It returns the
parsed, contract-checked `WebhookEvent` or throws a typed error (`signature_mismatch`,
`timestamp_out_of_tolerance`, `missing_header`). It uses Web Crypto (`crypto.subtle`) only, so it
runs in Node and at the edge. The body must be passed as received, never re-serialised.

**D3 Event schema: the signed envelope.** `WebhookEventSchema`, `.strict()`:

```ts
WebhookEvent {
  id,                 // the delivery id (UUID), stable across retries; equals webhook-id
  type,               // 'run.completed' | 'run.failed' | 'run.cancelled'
  createdAt,          // ISO-8601, when the run stopped (the outbox row was written)
  workspaceId,
  data: { run: { id, agentId, sessionId, status, endedAt, error, usage, cost, accountingState } }
}
```

`data.run` is `RunResourceSchema.pick(...)` of those fields, so it cannot drift from the run read.
`status` is the terminal status the type names. Deduplication is by run: **at most one delivery per
(webhook, run)**, enforced by a unique index. A terminal transition happens once per run (the
guarded `stopIn`), so the index is the database fact behind that rule, not its only guard.
`awaiting_approval` emits nothing, because it is stopped but not final (ADR-0151). A paused run
emits once, when its decision finishes it: `run.completed` when approved and `run.cancelled` when
rejected or expired. The continuation run then emits its own event. Usage and cost are read **when
the delivery is attempted**, not when the row is written. The first attempt waits until
`accountingState` leaves `pending`, or until 2 minutes after the stop, whichever comes first. The
payload always carries `accountingState`, so a receiver knows whether the numbers are final. A retry
may therefore carry later numbers than the attempt before it, under the same `id`.

**D4 Delivery and retry policy: PostgreSQL only, no new service.**

- **Outbox in the stop's transaction.** `stopIn`, for a terminal status, inserts one
  `webhook_deliveries` row per webhook of the run's workspace whose `events` contains the type, in
  the same transaction as the status update (`insert … select … on conflict do nothing`). A
  committed terminal run therefore has its deliveries, and a rolled-back stop has none. The table
  carries `workspace_id`, tenant-paired foreign keys to `webhooks (workspace_id, id)` and to
  `runs (workspace_id, id)` (both `on delete cascade`), `run_id`, `event_type`,
  `state: pending | delivered | failed`, `attempts`, `next_attempt_at`, `last_attempt_at`,
  `last_status_code`, `last_error` (a code, never a receiver body), `delivered_at` and `created_at`,
  with `unique (webhook_id, run_id)`. The migrations are expand-only.
- **Worker.** An in-process unref'd timer, the stale sweep's shape, runs every 5 seconds. Each tick
  takes the named maintenance lease `webhook-delivery`, so one replica claims per tick. Correctness
  does not rest on that lease. A claim is one statement:
  `update … set attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds' where id in (select id … where state = 'pending' and next_attempt_at <= now() and attempts < 8 order by next_attempt_at limit 25 for update skip locked) returning …`.
  The claim moves the row's due time past the attempt timeout, so a replica that dies mid-attempt
  leaves a row that becomes due again by itself. Before claiming, the same call settles a due
  `pending` row that has already had its 8 attempts as `failed`, with the `last_error` code
  `attempts_exhausted`, so a row whose claims keep lapsing is attempted at most 8 times. The lease
  is released before any HTTP is sent.
  Rows are attempted concurrently within a tick, at most 5 at a time.
- **An attempt.** `guardedFetch` (D5) with a **10 second** timeout and redirects refused. The answer
  body is read and discarded, up to 64 KiB. **Any 2xx** marks the row `delivered`, and it is never
  sent again. Anything else counts as a failed attempt: a non-2xx status, a timeout, a network error,
  a refused redirect, an egress refusal, a missing signing secret, or an attempt that throws before
  it sends (a run the schema refuses, a secrets read that fails, a secret that decodes to nothing),
  recorded as `internal_error`. Every attempt settles its claim.
- **Backoff.** After failed attempt _n_, the next one is due after
  `[30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h][n − 1]`, each multiplied by a uniform jitter factor
  in [0.8, 1.2]. That makes **8 attempts** over about 21 hours. After the eighth failure the row is
  `failed` and is not retried. A receiver's `Retry-After` is not consulted.
- **The accounting wait** (D3) reschedules a claimed row without counting an attempt.
- **Guarantee.** Delivery is at-least-once. A 2xx that is received but not recorded, because the
  process dies between the two, is sent again with the same `webhook-id`, and receivers deduplicate
  on it (or on `data.run.id`). Order across runs is not guaranteed.
- **Retention.** The same pass deletes `delivered` and `failed` rows more than 30 days old. The run
  cannot stop again, so no dedup is lost.

**D5 Egress.** Webhook URLs go through the existing egress policy,
`packages/core/src/net/egress-policy.ts` (ADR W9-PROV-127), with the deployment's
`loadEgressPolicyFromEnv` configuration. At create, `checkEgress` must allow the URL, or the route
answers `400 webhook_url_refused` and the message names only the host and the rule. Every attempt
goes through `guardedFetch`, which checks again because DNS answers change, refuses redirects and
pins `http:` targets. The URL is an absolute `https:` URL of at most 2048 characters without
userinfo or a fragment, or `400 invalid_webhook_url`. An `http:` loopback URL is accepted only where
the egress policy itself tolerates it (a non-production posture). `EGRESS_ALLOW_HOSTS` is the one
exemption, and it exempts from the range check, never from HTTPS.

**D6 RBAC.** A new resource `webhooks` in `apps/web/server/rbac/permissions.ts`: Owner `EVERYTHING`,
Admin `MANAGE` (read any, write any), Builder and Viewer none. `GET` is `read`, and `POST` and
`DELETE` are `write`. Endpoint configuration decides where a workspace's run data is sent, which is
the same kind of authority as API keys and memberships, so it sits with them. API keys reach the
routes with their role. Run gateway tokens and browser tokens are outside their scope and refused.
Create and remove write an audit row (`webhook-created`, `webhook-removed`) with the webhook id and
URL host, never the secret.

**D7 Feature id.** The routes declare `feature: 'runs'` in `packages/contracts/src/routes.ts`. They
are outcomes of runs, and ADR-0160's closed list gains no id. A workspace with `runs` disabled
answers `404 feature_disabled` on these routes, and it starts no runs, so it writes no deliveries.

**D8 Four names (ADR-0114).** Contracts: `WebhookEndpointSchema`, `CreateWebhookRequestSchema`,
`CreateWebhookResponseSchema`, `WebhookListResponseSchema` (`{ webhooks }`), `WebhookEventSchema`,
`WEBHOOK_EVENT_TYPES` and `WEBHOOK_PROBLEM_CODES`. Routes: `GET /api/webhooks`, `POST /api/webhooks`
and `DELETE /api/webhooks/:id` (`204`). SDK: `aw.webhooks.list | create | remove`, plus the free
function `verifyWebhookSignature` exported from `@indx-workspace/sdk`. CLI:
`aw webhooks list | create | remove`, where `create` prints the secret once and `--json` carries it.

**D9 Problem codes.** `400 invalid_body` (malformed or unknown keys, `events` empty, repeated or
unknown), `400 invalid_webhook_url`, `400 webhook_url_refused`, `400 invalid_webhook_id`,
`404 webhook_not_found` (also for another workspace's id), `409 webhook_limit_reached`,
`503 webhook_api_not_configured`.

**Declared shortcuts and gaps.**

- _shortcut: in-process delivery timer; a serverless (Vercel/Cloudflare) target delivers only while
  an instance is warm; upgrade to an `/api/cron/webhooks` route plus the `packages/cli` deploy
  renderers (as `/api/cron/triggers` does) when a serverless deployment needs webhooks._ Rows are
  durable either way: nothing is lost while no instance is warm, it is only late.
- No console UI for webhooks in #250. The API, SDK and CLI are the surface.
- No deliveries-list or redeliver route. A `failed` delivery is visible only in the database until a
  later unit adds `GET /api/webhooks/:id/deliveries`.
- No secret rotation route. D2's multi-signature header leaves room for one, and until then
  rotating means remove and create.

## Alternatives considered

- **Sign with a hashed secret, or with an asymmetric key (Ed25519).** Hashing loses because the
  platform must compute the HMAC. Ed25519, Standard Webhooks' `v1a`, would spare storing a per-webhook
  secret, but it needs a platform signing key with its own rotation and publication story. That is a
  larger new surface than one encrypted secret on an existing service. Moving to `v1a` later is
  additive: a second entry in the same header.
- **A bespoke `X-Agent-Workspace-Signature` header.** Loses because Standard Webhooks is what
  receivers' libraries already verify, it covers replay with a signed timestamp, and it reserves
  multi-key rotation.
- **Enqueue after commit, from the web process (an in-memory queue or an event emitter).** Loses: a
  crash between the commit and the enqueue loses the event, and the acceptance asks for redelivery.
  The outbox in `stopIn` is what makes "one delivery per terminal transition" true.
- **Redis, a queue service or `pg_cron`.** Loses: the platform's only required service is
  PostgreSQL, and `FOR UPDATE SKIP LOCKED` with an unref'd timer is the pattern already in use.
  `pg_cron` is not available on every managed PostgreSQL the profiles target.
- **Snapshot usage and cost into the row at stop time.** Loses: accounting settles after the stop
  (W9-RUNS-134), so a snapshot would almost always send `pending` numbers. Reading at attempt time,
  after a bounded wait, sends final numbers in the common case and says so in `accountingState`.
- **Emit `awaiting_approval` as an event.** Deferred, not rejected. It is a stopped, not a final,
  state, and N-3 names the three final ones. A `run.awaiting_approval` type can be added later as
  a new member of `events`.
- **A new feature id `webhooks`.** Loses: ADR-0160's list is closed, and a webhook without runs has
  nothing to send.
- **Admin `EVERYTHING` or Builder read.** Loses: webhooks have no `run` verb, and a Builder seeing
  where workspace run data goes is not needed for building agents. MANAGE matches the issue.

## Consequences

- A new table pair (`webhooks`, `webhook_deliveries`), a new public resource and a new outbound
  data flow from the platform. Every byte leaves through the egress policy, and the payload carries
  no prompt, output or transcript, only the run's id, status, error, usage and cost.
- `stopIn` gains one insert. A workspace with no webhooks pays one indexed empty select per stop.
- The signing secret appears in the workspace's secret list under its derived name, as the Zoom token
  does. Deleting it there makes the webhook's attempts fail until it is re-created. It is a
  platform-owned credential, like a storage connection's: the generic secrets routes refuse to
  create or replace a name of exactly that shape (`WEBHOOK_<32 hex>_SIGNING_SECRET`), and the tool,
  tool-endpoint and connector-identity secret resolvers answer it as missing without reading it,
  so no run can receive it and forge `run.*` events.
- `@indx-workspace/contracts` takes an additive minor (new exports). `@indx-workspace/sdk` gains
  `webhooks` and `verifyWebhookSignature`.
- Reversing D4 to a queue service would change only the worker. The outbox table and the envelope
  stay.

## Related decisions

- [ADR-0151](0151-a-stopped-run-holds-no-lease-and-run-start-is-idempotent.md): stopped versus final
  run statuses, and the S-6 idempotency semantics recorded alongside this in spec §5.12.
- [ADR-0144](0144-inbound-triggers-start-runs-from-a-webhook-or-a-schedule.md): the inbound
  direction, the show-once secret, the in-process timer and the Zoom-token secret storage.
- [W9-PROV-127](W9-PROV-127-egress-policy-design.md): the egress rule D5 applies.
- [ADR-0075](0075-one-error-envelope-and-an-authorised-audit-route.md),
  [ADR-0114](0114-the-sdk-and-the-cli-give-each-operation-one-name.md),
  [ADR-0160](0160-features-are-switched-off-per-deployment-and-workspace.md).
