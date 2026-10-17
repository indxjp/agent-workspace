# W9-PLAN — The membership list must return the joined user name

Status: accepted
Date: 2026-09-13
Decided by: the W9.7a landing task, under the Owner's renewed direction in issue `#181`
Scope: issue `#181`; the RBAC directory port, its two adapters, and the `GET /api/memberships` body

## Context

W9-TEAM-122 shows active members with a name and an email while reading members exclusively from
`GET /api/memberships`. The membership summary that landed in Wave 9 carries five fields — `id`,
`userId`, `email`, `role`, `createdAt` — and no name, even though the single workspace-scoped query
behind the list path already joins `users` in order to read `users.email`.

Two ways of closing that gap were available without changing the contract, and both are refused by
the task itself. Deriving a display name from the email's local part invents profile data the user
never chose. Reading `/api/users` from the Team screen and merging client-side crosses the API
boundary #122 draws and leaks a second workspace-wide read into a screen that needs only members.

An earlier attempt at this change, PR #177, was opened before the Owner directed a
documentation-only pause. It did not land: it is superseded by the present change, which is cut from
current `main` rather than from #177's base. Its source and test hunks were still correct and are
reused here; its documentation half asserted a chronology that `main` has since replaced, and is
rewritten rather than ported. See
[W9-PLAN-owner-resumed-wave-9-membership-contract](W9-PLAN-owner-resumed-wave-9-membership-contract.md)
for the authority under which this lands.

## Decision

`users.name` is part of the public membership shape, at every layer, for every workspace-scoped
membership result.

- `DirectoryMembershipRecord` gains `readonly name: string`, and `membershipColumns()` selects
  `users.name` from the join the list path already performs. The three sites that build a membership
  record by hand — `createUser`, `createMembership`, `acceptInvitation` — supply the name from the
  `users` row each of them already holds.
- `MembershipSummary` gains `readonly name: string`. The port type *is* the HTTP body, so the field
  added to the port is the field the response gains.
- Both adapters return exactly `id`, `userId`, `email`, `name`, `role`, `createdAt`. The PostgreSQL
  adapter's mapper becomes an explicit six-field literal instead of a `{ ...row }` spread, so the
  public shape is declared here rather than being whatever the repository record happens to grow.

The field is `string`, never `string | null`: `users.name` is `notNull` with a
`users_name_not_blank` check, so no null-name path exists and no migration or backfill is required.

Tenant scope is unchanged and is not weakened by the new field. The list path's one query is still
filtered by `eq(memberships.workspaceId, workspaceId)`; a name identifies a member exactly as an
email does, so both regression tests assert that a foreign workspace's name and email are absent
from the serialised response.

## Alternatives considered

- **Derive the name from the email local part in the memory adapter only.** Rejected twice over: the
  two implementations would stop returning the same public shape, and the derived value is precisely
  the invented profile data this task exists to avoid.
- **Let the Team UX call `/api/users` and merge client-side.** Rejected by #122's API boundary, and
  because it makes a member list depend on a workspace-wide user read.
- **Add a `GET /api/memberships?include=user` variant.** Rejected: a new query mode, a new route
  declaration and a second public shape, for one non-secret, non-null column already present in the
  join.
- **Keep the `{ ...row, createdAt }` spread in the PostgreSQL adapter.** Rejected: the requirement is
  an *explicit* public shape, and a spread republishes every future repository field by default.
- **Make `name` optional so no construction site has to change.** Rejected: the compile error at a
  construction site that forgets the name is the guard, and every current site was already in reach.

## Consequences

The `GET /api/memberships` body grows one field. The change is additive and non-breaking for JSON
consumers, and no client in this repository reads that endpoint yet — the Users screen still posts to
`/api/users` — so there is no UI migration here.

`name` is required, so any future code that builds either record type without a name fails
`pnpm typecheck` rather than shipping a membership nobody can name. Rollback is a plain revert: there
is no migration and no data change.

W9-TEAM-122's stated prerequisite is met once this lands; #122 itself stays open and is not closed by
this change.
