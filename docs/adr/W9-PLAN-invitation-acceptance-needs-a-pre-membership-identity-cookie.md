# ADR-W9-PLAN — Invitation acceptance needs a pre-membership identity cookie

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator, after the W9-TEAM-121 inherited-diff audit
Scope: the W9-TEAM-121 authentication boundary, acceptance transaction and ownership partition

## Context

The W9-TEAM-121 card required a new OIDC identity with no existing user or membership to accept an
invitation. The inherited implementation put `POST /api/invitations/:id/accept` behind
`identifyCaller`, which can construct a principal only after a tenant session resolves to a current
membership. `apps/web/proxy.ts` also requires that session for the route. Meanwhile the OIDC
callback deliberately refuses an identity with zero current memberships. Those three positive
guards form a closed loop: the membership is needed to reach the operation that creates the first
membership.

Treating an oldest Owner as the caller would repeat the identity-substitution defect found during
W9-WS-119. Making acceptance public with only a bearer invitation token would drop the issue's
independent authenticated-identity match. Neither is acceptable.

## Decision

W9-TEAM-121 owns the smallest pre-membership authentication bridge as part of its one PR.

After a successful OIDC exchange, an identity with zero current memberships receives a short-lived,
signed, HttpOnly invitation-identity cookie. It carries normalized email plus OIDC issuer and
subject, has a token-version tag distinct from tenant sessions and workspace-selection tokens, and
contains no workspace, role or grant. The callback still mints no tenant session and does not query
or reveal whether an invitation exists.

The proxy exempts only the exact invitation-accept POST path from the tenant-session gate. The route
therefore performs its own same-origin check, verifies the dedicated cookie and refuses a tenant
session by itself as insufficient. Acceptance atomically consumes the invitation, creates or reuses
the intended user, binds issuer and subject to that user, creates the membership and stamps
acceptance. On success the route clears the one-purpose cookie and may mint the new workspace's
tenant session from the transaction's returned workspace slug. Every refusal remains no-store and
must not distinguish a foreign invitation from a nonexistent one.

The ownership partition expands to the exact proxy, auth callback and invitation-identity files
needed for this bridge. No active W9.6 sibling owns those paths.

## Alternatives rejected

- **Require an existing tenant session.** Rejected because a genuinely new invitee cannot have one.
- **Accept the invitation token without OIDC.** Rejected because possession of the relayed link is
  not the issue's required authenticated-identity match.
- **Reuse the workspace-selection cookie.** Rejected because it names an existing `users.id`; a new
  invitee has none, and widening that token would blur two separately verified capabilities.
- **Create a provisional global user in the callback.** Rejected because callback execution alone
  must not turn any authenticated external identity into durable application state.

## Consequences

The #121 verifier must exercise the real zero-membership OIDC callback path and prove it receives no
tenant session, then redeem an invitation with the dedicated cookie and prove the identity binding,
membership and acceptance stamp commit together. Mutating the exact proxy exemption, the cookie's
token-version/expiry checks, the same-origin check or the transactional identity bind must make a
named test fail.

