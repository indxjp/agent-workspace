# ADR-0083 — The CLI signs a person in with a device flow and a short-lived user token

Status: accepted
Date: 2026-09-30
Decided by: the implementer of SDK unit 10 (SDK migration programme, tracker #232, issue #242)
Scope: `packages/contracts/src/cli-auth.ts`; `packages/core/src/db/schema/cli-sessions.ts`,
`packages/core/src/db/repositories/cli-sessions.ts`, migration `0030_create_the_cli_sessions_table`;
`apps/web/server/cli-auth/**` (including `rate-limit.ts` and `token-routes.ts`),
`apps/web/server/rbac/{cli-token,principal,http}.ts`,
`apps/web/server/composition/session-rbac.ts`, `apps/web/proxy.ts`,
`apps/web/app/api/auth/cli-{device,verify,token,workspace}/route.ts`;
`packages/sdk/src/{http,resources/cli-auth,resources/workspaces}.ts`;
`packages/aw/src/{credentials,config,main,commands/auth,commands/workspaces,commands/team}.ts`.

## Context

`aw` could hold only an API key, and every `/api/workspaces` and `/api/invitations` route refuses
an API key (`403 api_key_not_permitted`, ADR W9-WS-119): a key acts for one workspace with a fixed
role and represents no person. So the eight workspace and invitation commands existed in the SDK
but not in the binary (S-22). The issue left open whether to add a device-code flow or to widen
the browser token of unit 4 (#236) to a user scope.

## Decision

1. **An OAuth 2.0 device authorization grant (RFC 8628).** `POST /api/auth/cli-device` answers a
   device code and a user code; the person opens `/api/auth/cli-verify` in a browser where they
   are signed in and approves or denies the code; `POST /api/auth/cli-token` answers RFC 8628
   §3.5's `authorization_pending`, `slow_down`, `access_denied`, `expired_token` and
   `invalid_grant` until it issues the token, exactly once. A device flow was chosen over a
   loopback redirect because it works over SSH and in containers, and over a widened browser token
   because a browser token is minted by a principal that already exists — here none does yet.
2. **The device code is signed, not stored.** It is `v1.<user code>.<expiry>.<HMAC-SHA-256>`
   under the deployment's session secret with a purpose label, so the unauthenticated start route
   writes nothing and an anonymous caller has nothing to exhaust. A `cli_sessions` row is written
   only when the person answers, because only then is the workspace known and a tenant-scoped
   table cannot hold a row with no workspace. A user code is answered at most once.
3. **A user token, `awu_live_<22>_<43>`, twelve hours, no refresh.** The same grammar and
   cryptography as `ak_live_`/`awt_live_`; only a SHA-256 of the secret half is stored. Twelve
   hours is the browser session's own lifetime; when it ends, `aw login` again. A refresh token
   would be a second long-lived secret on disk for a flow that takes one click to repeat.
4. **The token is a person, not a role.** It verifies to a `Principal` with `kind: 'membership'`
   and a new `via: 'user-token'`; the role is re-read from the membership on every request, as
   for a session cookie. On the routes it is admitted to, it therefore acts exactly as that
   person's browser session would, through the same `authorise()`/`decide()` table, and W9-WS-119 is unchanged: `via === 'api-key'`
   is still refused. It is admitted **only on the person-facing routes**: `/api/me`,
   `/api/workspaces/**`, `/api/invitations/**`, `/api/sharing-policies/**`,
   `/api/auth/cli-token` and `/api/auth/cli-workspace` (`apps/web/server/cli-auth/token-routes.ts`).
   Two layers read that one list: the proxy passes an `awu_live_` bearer only there, and
   `resolveActor` refuses to resolve one on any other path — so no route family can act on it,
   whatever the proxy let through for another reason (it opens `/api/sessions/**` to the runner's
   run token) and whatever cookie rode along. The `/api/sessions/**` seam also refuses
   `via === 'user-token'` by name, as it refuses a scoped browser token. The row references `(workspace_id, user_id) → memberships ON DELETE
   CASCADE`, so removing the membership deletes the sign-in, and the database refuses to move a
   token to a workspace the person is not a member of.
5. **Revocation and switching act on the token itself.** `DELETE /api/auth/cli-token` revokes the
   presented token (`aw logout`); `POST /api/auth/cli-workspace` moves it to another of the
   person's memberships (`aw workspaces select`, and the SDK's `workspaces.select` for a
   `user-token` client).
6. **Only a browser session may approve.** The approval `POST` keeps the proxy's session and
   same-origin gate and checks both again; a bearer credential of any kind is refused there. The
   approval page is `no-store`, `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
7. **Storage on the client.** `~/.config/agent-workspace/credentials.json`, keyed by control plane
   URL, file `0600` in a `0700` directory, written to a temporary sibling (created exclusively,
   `wx`, so a planted symlink or stale file is never followed) and renamed. The directory is
   `chmod`ed to `0700` on every write, because `mkdir`'s mode applies only to a directory it
   creates and `~/.config/agent-workspace/` usually exists already for `profiles.json`. The token
   is never a flag, never printed, never in `--json`. A configured API key always wins over the
   sign-in, so a person signing in never changes what an automation on the same machine acts as.
8. **Route classification.** The three pre-authentication steps are public routes of the
   authorisation matrix and the approval, revocation and switch are identity-only routes, like
   `POST /api/invitations/:id/accept`: each acts on the caller's own sign-in, not on a workspace
   resource a role grants. `POST /api/auth/cli-workspace` and `DELETE /api/auth/cli-token` in
   particular are identity-only exemptions following `/api/auth/workspace`, the browser's own
   workspace switch: they move or end the presented credential itself, and the handler proves the
   caller by that credential rather than through `authorise()`. A browser session therefore passes
   the proxy on those two but is refused `401` by the handler — it names no CLI token to revoke or
   move.
   The three pre-authentication steps are on the proxy's exact
   allowlist beside `/api/setup` and the OIDC exchange; without a configured deployment (no
   database, so no `cli_sessions` repository) each answers `503 cli_auth_not_configured`, never
   the gate's `401`. `tests/auth.test.ts` declares them as the gate's exceptions, and
   `tests/no-route-answers-503.test.ts` drives them against a configured deployment (none answers
   `503`) and declares the two handler refusals of a session by name.
9. **Admission limits (review round 1).** `POST /api/auth/cli-device`, `POST /api/auth/cli-token`
   and the approval `POST` are each limited per client (10, 60 and 10 a minute) and answer
   `429 rate_limited` with `Retry-After` beyond it. The client is the proxy-authenticated address
   the public share routes already derive (`AW_TRUSTED_PROXY_HOPS`); without a trusted proxy chain
   no address is unforgeable, so every caller shares one bucket ten times as wide. The counts and
   the `slow_down` memory are bounded maps that forget the least recently written key in O(1) at
   capacity (10 000) — no sweep on any request. Both are per process.
10. **Confirming a pre-filled code (RFC 8628 §5.4).** The link `aw login` prints carries
    `?code=`, which pre-fills the form, so a mailed link could make approving an attacker's code
    one click. Approval therefore requires ticking "this is the code `aw login` printed in my own
    terminal just now" — a checkbox the browser requires and the handler checks again (`400`
    without it). Denying needs no confirmation. Recording the request's origin (time, client
    address) at start and showing it would be a stronger signal but would give up the stateless
    device code of §2; it is not done.
11. **Contracts version (ADR-0078).** The new routes sit behind the proxy's version negotiation
    like every `/api/**` route: a request that states a served version is admitted, one that
    states an unserved version gets `426`, and a browser's form post (no header) is served at
    the current version. The SDK's `AuthClient` requests go through `HttpClient`, which sends the
    header on every request.

## Consequences

- `aw login|logout|whoami`, `aw workspaces list|get|create|update|select` and
  `aw team invitations list|create|resend|revoke` exist. `aw team invitations accept` does not: the
  route proves the invitee through the identity provider's invitation cookie, which a CLI token is
  not; that stays a browser step.
- The start route writes nothing, but it is rate-limited per client anyway (§9), because every
  answer is a fresh valid pair an attacker could poll with. Polling is throttled per device code
  (`slow_down`) and per client. A deployment with several replicas limits per replica.
- A PostgreSQL-backed repository test (`packages/core/src/db/repositories/cli-sessions.test.ts`)
  and a composition test through the real routes
  (`apps/web/server/composition/cli-token-composition.integration.test.ts`) pin the one-shot
  exchange, the foreign-key mapping, the membership cascade and the person-facing-only admission.
- The formal ER model covers `cli_sessions` (review round 1): `TableName.cliSessions` and
  `IdKind.cliSession` in `formal/AgentWorkspace/{Er/Core,Prelude/Ids}.lean`, the ninth table of the
  identity cluster, its two foreign keys (the membership one tenant-paired and cascading, proved by
  the new `Normative.ErCore.cli_session_member_reference_is_required`), its unique keys and its five
  checks, read from `0030_snapshot.json`. No theorem was weakened or deleted. The theorems that pin
  exact table, key and check counts or lists were restated in place for the new table, as #326 did
  for its table: `table_names_match_schema` (37 tables), `catalogue_constraint_counts`,
  `workspace_is_the_tenant_root` (34 scoped tables), `refined_checks_cover_the_cluster`,
  `clusters_partition_the_tables`, `er_diagram_draws_each_relationship_once`,
  `timestamps_are_not_on_every_table` and `identity_rows_belong_to_exactly_one_workspace` (each now
  names `cliSessions`); each keeps its name, so the successor is the same theorem over the wider
  model. `invitation_row_is_admitted` only gained a larger `maxHeartbeats`.
- Out of scope, and unchanged: OIDC for the control plane's own UI.
- Amended by [ADR-0161](0161-an-app-backend-acts-as-the-signed-in-person-by-token-exchange.md):
  an app backend acting as a signed-in person gets an ADR-0134 `awo_live_` access token by token
  exchange, not this `awu_live_` user token, which stays as decided here.
