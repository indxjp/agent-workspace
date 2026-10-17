# ADR-W9-TEAM-121 — Invitation lifecycle is a durable state machine

Status: accepted
Date: 2026-09-12
Decided by: W9-TEAM-121 implementing agent
Scope: `packages/core/src/db/schema/invitations.ts`,
`packages/core/src/db/repositories/directory.ts`, `apps/web/server/invitations/**`,
`apps/web/server/auth/invitation-identity.ts`, `apps/web/proxy.ts`,
`apps/web/app/api/auth/callback/route.ts`, `apps/web/app/api/invitations/**`

## Context

Issue #121 requires a workspace invitation to be expiring, revocable, resendable, single-use,
workspace-bound, safe under concurrent duplicate creation and acceptance, and free of plaintext
token storage. It also asks for defined outcomes when the address already belongs to a user or a
member, and when a pending invitation is duplicated or its role would exceed the inviter's own
authority.

Those requirements are one state machine, not a set of unrelated route checks. If a route first
reads state and later writes without repeating the state predicate, an acceptance can commit between
those statements and a resend can rotate an already-consumed token. If duplicate prevention is an
application lookup followed by an insert, concurrent callers can both observe absence. If archive
is checked after the invitation is selected, the refusal becomes an oracle for a workspace the
caller has not proved they may name.

## Decision

An invitation row has one live state — both `accepted_at` and `revoked_at` are null — and two
terminal states, accepted or revoked. The database check constraint refuses a row that claims both
terminal states.

The partial unique index on `(workspace_id, email)` applies to live rows. Creating a normalised
duplicate therefore lets PostgreSQL choose exactly one insert; the repository maps that named
constraint to `already-invited`. Expiry does not silently remove a row from this index. An expired
invitation remains the one pending history for that address until an authorised caller resends it
or revokes it.

Resend and revoke are guarded writes whose `WHERE` clause repeats the live-state predicates. They
read the current row only after a guarded write returned no row, to report the terminal state that
actually committed. Resend mints a fresh token/hash pair and fresh expiry; the old hash is replaced.

After OIDC succeeds for an identity with no current membership, the callback mints a short-lived
signed `__Host-aw_invitation_identity` cookie and creates no user or identity binding. Its distinct
token version carries only normalised email, issuer, subject, issue time, and expiry — never a
workspace, role, user id, or grant. The proxy exempts only the exact acceptance POST from the tenant
session gate; the route checks same-origin and the dedicated cookie itself. A valid tenant session,
including one for another workspace, is insufficient and is refused before any invitation lookup.

Acceptance runs inside one transaction and locks the invitation row. Its admission query positively
matches invitation id, token hash, normalised authenticated email, and a non-archived workspace.
Absence, mismatch, and archive all return `invalid`. After admission, revoked, accepted and expired
are stable outcomes; otherwise the transaction creates or reuses the global user, binds the OIDC
issuer and subject to that same user, creates the workspace membership if absent, and stamps
`accepted_at`. A conflicting existing OIDC binding returns `invalid` without leaving a user,
membership, or acceptance write. An already-member outcome also consumes the token. Concurrent
replay therefore produces one membership and one terminal acceptance. A successful new membership
clears the one-purpose identity cookie and mints a tenant session for the invited workspace.

The invitation role is immutable. Changing it means revoke followed by create; resend preserves it.
Every role entering create has the branded `ConferredRole` produced by `conferral.ts`, so the
existing dominance rule — including Admin's inability to confer Owner or Builder — is the only role
table used.

Administrative lifecycle writes resolve the session actor from the current membership list again
immediately before mutation. If that membership vanished after the request principal was built,
the write is refused as undecidable. They never use `resolveActorUserId`'s oldest-Owner fallback:
that fallback is a stamping default for API-key-created resources, not permission to attribute a
human action to a different person.

The plaintext token exists only in the create/resend result and the manual sender call. Listable
and audit shapes have no token or token-hash field. Manual link mode returns the link to the inviter
and sends no mail; that deployment limit remains declared as Wave 9 gap G-10. Direct
`/api/users` and `/api/memberships` provisioning stays available, as the issue permits.

## Alternatives considered

- **Application-side duplicate lookup.** Rejected because it cannot serialize concurrent inserts.
- **Plain unique `(workspace_id, email)`.** Rejected because terminal history would permanently
  prevent a later invitation.
- **Delete on accept or revoke.** Rejected because lifecycle and audit attribution would disappear.
- **Return distinct mismatch errors.** Rejected because invitation id and workspace membership would
  become an existence oracle.
- **Reuse a tenant session as the identity proof.** Rejected because a new invitee cannot have one,
  and a session for another tenant must not become authority over this invitation.
- **Bind or create a user in the OIDC callback.** Rejected because authentication alone is not an
  invitation and must not create durable application state.
- **Treat expiry as automatic revocation.** Rejected because no scheduled transition exists; resend
  is the explicit operation that renews an expired pending row.

## Consequences

- A live invitation has one authoritative row and token hash.
- Resend/revoke/accept races follow database lock and predicate order rather than stale application
  reads.
- Archived workspaces retain invitation history but cannot gain a membership through an old link.
- The identity binding and membership either commit together or neither does.
- A caller must revoke an expired invitation before creating a different role for the same address,
  or resend it to preserve the original role.
- Email delivery remains a follow-up integration at the `SendInvitation` interface, not a hidden
  capability of this deployment.
