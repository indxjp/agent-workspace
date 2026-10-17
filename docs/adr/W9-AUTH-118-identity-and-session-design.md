# ADR-W9-AUTH-118 — Identity key, session role, and the selection cookie's lifetime

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-118 implementing agent
Scope: `packages/core/src/db/schema/user-identities.ts`, `apps/web/server/auth/{session,selection}.ts`, `apps/web/app/(shell)/layout.tsx`, `apps/web/server/rbac/{directory,memory-directory,postgres-directory}.ts`

## Context

Issue #118's acceptance criteria: "An OIDC identity maps stably by issuer + subject to one user,"
and "The shell shows database workspace/user names and the actual role." Neither the issue nor the
plan card states the schema shape, whether the session token's `role` field may carry a value other
than `'owner'`, or how long a post-callback workspace-selection state should live. Three readings
had to be chosen.

`apps/web/server/auth/session.ts`'s `SessionClaims.role` is typed as the literal `'owner'`, and
`verifySessionToken` rejects any other value — a W1-CP-06 decision this task's card explicitly
says not to widen ("No session-claim role widening beyond what membership already supplies").
`apps/web/server/rbac/principal.ts`'s `Principal.fromSession` already re-reads the real role from
`directory.resolveRole(email, workspaceId)` on every request and never reads `claims.role` for an
authorization decision — the session's `role` field is vestigial. The one place that DID read it
for display, `apps/web/app/(shell)/layout.tsx`, is the bug issue #118 names.

## Decision

1. **A new table, `user_identities(issuer, subject, user_id)`, unique on `(issuer, subject)`.**
   `users` gains no column: it is tenant-exempt for the same reason `packages/core/src/db/schema/tenancy.test.ts`
   already gives for `users` and `workspaces` — an identity binding is not tenant-specific, so it is
   added to `TENANT_EXEMPT` alongside them.
2. **Every session this build mints keeps `role: 'owner'` in its claims, unconditionally**,
   regardless of the caller's real membership role. Nothing reads it for authorization; the field
   exists only because `session.ts`'s wire format has always carried it and widening the literal
   union is out of this task's minimum. The real role is read fresh, per request, from
   `directory.membershipsForUser(userId)` — by `ShellLayout`'s new `resolveIdentity` for display,
   and (unchanged by this task) by `Principal.fromSession` for authorization.
3. **The post-callback selection cookie (`apps/web/server/auth/selection.ts`) has no single-use
   nonce — only a ten-minute TTL.** `POST /api/auth/workspace` re-reads `membershipsForUser` on
   every use, so replaying the cookie against a membership that still exists mints a valid session
   again (idempotent); replaying it against a membership that was removed is refused (re-checked,
   not cached). A single-use token would additionally have to survive a browser back-button retry
   and a double form submit without punishing the caller for either, which is the configuration and
   revocation machinery a full nonce store brings and this task's Minimum implementation does not
   ask for.

## Alternatives considered

- **Widen `SessionClaims.role` to all four roles and mint the real one.** Rejected: the card is
  explicit that this is out of scope, and every consumer of `role` already re-reads from the
  directory, so widening would add a second place authorization data could disagree with the
  database — the exact hazard `apps/web/server/rbac/principal.ts`'s header warns about for a role
  "in a bearer token."
- **Put the OIDC identity mapping on `users` as nullable `issuer`/`subject` columns.** Rejected:
  `users.ts`'s own header forbids adding anything tenant-specific, and while an identity mapping is
  not tenant-specific either, one user can plausibly bind more than one issuer's identity to the
  same account over an account's lifetime (e.g. a migration between identity providers) — a second
  satellite table keeps that door open without a migration later, at the cost of one join now.
- **A single-use selection token, invalidated after first success.** Rejected as unnecessary
  machinery for what the card's Minimum implementation asks; the TTL is the stated defence, and the
  verifier attack's own wording ("assert the second attempt is refused **or is idempotent**")
  accepts this reading.

## Consequences

- A future task that needs a session role other than the vestigial `'owner'` must revisit
  `session.ts`'s literal union — this ADR only says today's build does not.
- `resolveIdentity` (in `layout.tsx`) returns `null`, and the shell shows the session's own fields
  as a fallback, whenever the RBAC runtime is unwired or the named membership is gone. That is a
  deliberate "say less, not more" choice consistent with `docs/adr/W1-UI-01-the-shell-shows-what-it-knows.md`.
- A selection cookie can be replayed for as long as ten minutes against any membership that still
  exists. That is a stated property, not a silent one: `apps/web/app/api/auth/workspace/workspace.test.ts`
  proves the replay is bounded by re-reading membership, not by a nonce.
