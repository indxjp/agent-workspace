# ADR-FORMAL-P1-identity-permission-tenant-selection — The sign-in token carries identity by user id, and no permission

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `apps/web/server/auth/session.ts`, `packages/core/src/db/repositories/root.ts`, `apps/web/server/rbac/principal.ts`

## Context

`docs/architecture.md`: "_A session proves identity; RBAC proves permission; a repository scope
proves tenant selection. None substitutes for another._" Three places blur the three:

- The sign-in token's subject is the user's **email** (`SessionClaims.sub`), and every request
  resolves its membership by email and slug (`resolveMembership(email, workspaceSlug)`), although
  `user-identities.ts` says "_email alone is not stable enough to be the identity key_" (identity
  finding 9). `current_identity_breaks_on_an_email_change` shows a session that stops resolving
  when the email changes.
- The token carries `role: 'owner'`, always, and verification rejects any other value, so the claim
  carries no information (`role_claim_carries_no_information`, identity finding 10); a
  permission-shaped field in an identity token invites the conflation the rule forbids.
- "Principal" names both the durable row and the per-request authenticated object (identity
  finding 4), and "session" both the conversation and the sign-in credential (work F-6).

## Decision

- At the next token version, mint `sub` as `users.id` and resolve the membership by user id and the
  selected workspace; drop the `role` claim. `resolution_by_id_refines_resolution_by_email` shows
  the two resolutions agree wherever the email finds the user, and
  `target_identity_survives_an_email_change` that the new one never depends on an email.
- Name the per-request object the **authenticated principal** (the TypeScript `Principal` class,
  with its `actor` field renamed `displayActor` when next touched) and the credential the
  **sign-in session**, as `docs/formal/concepts.md` does.

## Alternatives considered

- **Keep email as the key and forbid email changes.** Leaves identity keyed by an attribute the
  OIDC provider may change.
- **Keep the role claim for display.** The role must be read from the directory on every request
  (`role_is_read_from_the_membership`); a stale copy in a token is a hazard with no use.

## Consequences

- A token-version bump: old tokens stay valid until they expire, verified by the old rule.
- `identity_does_not_determine_permission` and `tenant_selection_requires_a_membership` state the
  target's separation as theorems over the resolution model.
