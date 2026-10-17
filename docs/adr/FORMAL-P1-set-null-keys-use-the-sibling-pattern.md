# ADR-FORMAL-P1-set-null-keys-use-the-sibling-pattern — A `SET NULL` reference uses the sibling pattern

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/projects.ts`, `packages/core/src/db/schema/sessions.ts`, `packages/core/src/db/repositories/agents.ts`, a migration

## Context

`projects_default_agent_workspace_fk` and `sessions_project_workspace_fk` are composite
`ON DELETE SET NULL` keys that include the `NOT NULL` `workspace_id`. PostgreSQL nulls every key
column, so deleting an agent that is a project's default, or a project with sessions, fails with
`23502` (er-core finding 1, reproduced on PostgreSQL 17). `tenancy.test.ts`'s `referenceIdentityOf`
comment names the hazard. The rest of the schema already uses the sibling pattern: a single-column
`SET NULL` key beside a tenant-paired `NO ACTION` key (`agents.model_connection_id`).

## Decision

Make both composite keys `NO ACTION` and add the single-column siblings
`projects_default_agent_id_agents_id_fk` and `sessions_project_id_projects_id_fk`
(`ON DELETE SET NULL`). Add a regression test that deletes a default agent.

## Alternatives considered

- **PostgreSQL 15+ `ON DELETE SET NULL (default_agent_id)`.** One key instead of two, as migration
  0020 already does for `audit_events_actor_principal_workspace_fk`; Drizzle's DSL cannot express
  it, so it lives in hand-written SQL and the snapshot records the wrong action (work finding F-5).
- **Clear the reference in the repository before deleting.** Fixes the route, not another writer.

## Consequences

- `set_null_diverges_exactly_at` names the two keys today and none in the target;
  `deleting_a_default_agent_diverges` shows the delete refused today and allowed in the target.
- The siblings are `sibling-paired`, so `tenancy.test.ts` accepts them unchanged, and
  `every_tenancy_constraint_is_kept` shows the composite keys keep their class.
