# ADR-W9-AUTH-117-ownership-columns-and-backfill — `created_by`, its target, and its backfill

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-117
Scope: `packages/core/src/db/schema/{agents,files,skills,mcp-servers}.ts`, `migrations/0010_little_power_pack.sql`, `packages/core/src/db/seed.ts`

## Context

Issue #117: `agents`, `files`, `skills` and `mcp_servers` record no creator, so a Builder's "own"
grant (`apps/web/server/rbac/permissions.ts`'s `OWN_WRITES`) can never be established, and every
item route denies with `ownership: 'unknown'`. The card's Minimum implementation: "One migration
adding `created_by` to `agents`, `files`, `skills` and `mcp_servers` with a tenant-paired composite
foreign key to `memberships(workspace_id, user_id)`… Backfill every existing row to the workspace's
oldest Owner membership."

Two things the card states but a reader still has to choose the shape of:

1. **The target of the foreign key.** A single-column `created_by -> users.id` says the identity
   exists globally; it says nothing about whether that identity belongs to *this* workspace. §25
   forbids exactly that gap — the same reasoning `sessions.user_id` already carries, alongside its
   own `sessions_member_workspace_fk` to `memberships`.
2. **What the backfill picks when a workspace has more than one Owner**, and what it must never
   produce (`NULL`, or a value that fails the new constraint on existing data).

## Decision

`created_by` is `uuid NOT NULL`, with **one** foreign key per table:
`(workspace_id, created_by) -> memberships(workspace_id, user_id)`, named
`<table>_created_by_workspace_fk`. There is no separate single-column reference to `users(id)` —
the composite constraint alone proves both "this identity exists" and "this identity is a member
of this workspace", and a single-column sibling would only restate the first half. Because the
column name is `created_by`, not `created_by_id`, `tenancy.test.ts`'s `*_id`-suffix rule does not
force a declaration either way; the constraint is added because the feature needs it, and
`tenancy.test.ts`'s cross-tenant referential-integrity rule (which inspects every declared foreign
key, not only `*_id`-suffixed ones) verifies its shape is correct.

The migration backfills every existing row with:

```sql
SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.user_id
FROM memberships m
ORDER BY m.workspace_id, (m.role = 'owner') DESC, m.created_at ASC, m.id ASC
```

— the workspace's oldest Owner, ties broken by membership id, falling back to the workspace's
oldest membership of any role only if it somehow has no Owner (defensive; every workspace this
programme creates gets one at creation, and the last-Owner rule in
`docs/adr/W2-CP-06-the-four-roles-and-their-permission-split.md`'s directory layer refuses to
remove the last one). `packages/core/src/db/seed.ts` attributes the seeded General agent to the
seeded bootstrap administrator the same way, for the same reason: an explicit, documented owner,
never `NULL`.

## Alternatives considered

- **`created_by -> users.id` alone, no tenant pairing.** Rejected: it is exactly the gap §25 exists
  to close, and the issue's own acceptance criterion is explicit — *"Cross-workspace IDs cannot be
  used in ownership or grant rows."*
- **Both a single-column `users.id` reference and the composite one**, mirroring `sessions.ts`'s
  two constraints. Rejected as an unneeded second constraint: `sessions.user_id` carries its own
  `RESTRICT`-on-delete semantics distinct from the membership pairing (a session must survive a
  member's removal for the audit trail); `created_by` has no such second obligation here, so one
  constraint says everything that needs saying.
- **Backfilling to a fixed sentinel "system" user.** Rejected: it is a guess finer-grained than
  the data supports (which specific user "did" a historical create is genuinely unknowable), and
  it fails the "not NULL" bar without adding real information — the oldest Owner is the same
  degree of approximation the issue itself accepts, spelled out as the rule rather than invented
  per call site.

## Consequences

- `created_by`'s foreign key uses PostgreSQL's default `ON DELETE NO ACTION`/`NO UPDATE` (the same
  choice `sessions_member_workspace_fk` makes for the identical shape): removing the last row that
  references a membership is unaffected, but removing a membership while it is still the recorded
  creator of a row is restricted at the database level the same way `sessions.user_id`'s own
  membership pairing already is. This is a declared limitation, not a bug: this task builds no
  resource-transfer API (see the card's "Deliberately not built"), so a workspace that must remove
  a departing Builder's membership while they still own rows needs a later task's transfer/delete
  tooling — todayâ€™s reading is "ownership does not move in Wave 9."
- A future migration that wants `created_by` nullable (e.g. "creator unknown") would need to widen
  every reader of the column, including `apps/web/server/resources/item-ownership.ts`'s comparison
  — this ADR's backfill choice is why that widening has not been needed yet.
