# ADR-0116 — Admin manages skills and files

Status: accepted
Date: 2026-10-05
Decided by: the product owner (option A, issue #694 FH-07)
Scope: `apps/web/server/rbac/permissions.ts` (Admin's `skills` and `files` cells), `formal/AgentWorkspace/Authz/**`; supersedes Decision 2 of W2-CP-06

## Context

[W2-CP-06 Decision 2](W2-CP-06-the-four-roles-and-their-permission-split.md) read §21's Admin
clause — "Users, agents, models, API keys, connectors, runtimes." — literally, so
`grantsFor('admin', 'skills')` and `grantsFor('admin', 'files')` were `none` while a Builder held
`OWN_WRITES` over both. An Admin got `403 forbidden` listing, importing or editing a skill, even
though it could edit every agent those skills are assigned to.

[ADR-0102](0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md) states the
product's model of the roles the other way: "An Admin can change anything a Builder can." The
two records disagreed, and an Admin key could not run the first-hour skill flow.

This decision closes that gap for skills and files only. ADR-0102's sentence is still not true of
the table as a whole: Builder holds its own `projects` and runs its own `connectors`, and Admin
holds neither (see Consequences and `admin_is_not_above_builder_exactly_at`).

## Decision

Admin holds `skills` and `files` as `EVERYTHING` — read, write and run over every row in the
workspace. This is how Admin already holds `agents`, the other resource Builder holds as
`OWN_WRITES`.

`MANAGE` (`run: none`) was rejected: Builder holds `run: own` over both, so `MANAGE` would still
leave Admin narrower than Builder on those cells. Every other role and every other cell is
unchanged.

## Consequences

- An Admin key can list, import, update and delete any skill and any file.
- Admin still may not confer Builder (`conferral.ts`): Builder holds its own `projects` and runs
  its own `connectors`, which Admin's grants do not cover. Only the stated reason changes.
- The Lean model's Admin policy gains the two cells and
  `admin_is_not_above_builder_exactly_at` now names `(connectors, run)`, `(projects, read)` and
  `(projects, write)`.
- W2-CP-06 Decision 2 is superseded; ADR-0077 and W9-TEAM-185 are historical and stay as written.
