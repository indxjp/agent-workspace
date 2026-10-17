/**
 * `sessions` — one conversation with one agent (spec §20, §27).
 *
 * §20 lists exactly what to store: "workspace user / agent / Claude session ID / created_at /
 * updated_at / status". Those are the columns below, plus a title for §19.5's Recent list.
 *
 * `engine_session_id` is nullable because it does not exist until the engine reports it on the
 * first run — for the Claude Agent SDK, the `system/init` message (R-01 §3): the row is created
 * when the user sends, and filled in when the engine answers. A session that never started a run
 * keeps a NULL there forever, which is the honest representation of "no engine session was ever
 * created". ADR-0065 renamed the column from its Claude-specific name: the id belongs to whichever
 * engine ran the session, and only one engine could ever produce one before.
 *
 * `engine` says *which* engine that was. It is nullable for the same reason, and for one more: a
 * row whose `engine_session_id` is NULL has not been pinned to an engine yet. Migration 0025
 * backfills every row that does have an id, so `engine IS NULL AND engine_session_id IS NOT NULL`
 * is unreachable from that point on.
 *
 * `agent_version_id` is the agent version the conversation started on (issue #612): written once,
 * when the row is inserted, and never updated, so a later `aw push` cannot change what an open
 * conversation runs. NULL means a legacy, unversioned agent, which runs from the `agents` row.
 */
import { foreignKey, index, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { agentVersions } from './agent-versions.js';
import { agents, engineIds } from './agents.js';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { memberships } from './memberships.js';
import { oneOf } from './one-of.js';
import { projects } from './projects.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

/** §20's four supported operations reduce to two states: a session is either live or archived. */
export const sessionStatuses = ['active', 'archived'] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

export const sessions = pgTable(
  'sessions',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * `RESTRICT`, not `CASCADE`: run history outliving a departing user is the enterprise
     * expectation (§36 wants an audit trail), so deleting a user who has ever run something
     * must be an explicit decision — reassign or delete the sessions first — rather than a
     * silent cascade that destroys the record.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    /**
     * The reference to the agent is **tenant-paired** and declared in the table config below as
     * `sessions_agent_workspace_fk`, not here: `(agent_id, workspace_id)` must point at one row
     * of `agents (id, workspace_id)`, so a session cannot name an agent in another workspace.
     * See that constraint for the `ON DELETE CASCADE` reasoning.
     */
    agentId: uuid('agent_id').notNull(),
    /** A session belongs to at most one project and may be moved between projects. */
    projectId: uuid('project_id'),
    /** The engine's own session id. NULL until the first run reports it. */
    engineSessionId: text('engine_session_id'),
    /** Which engine produced {@link engineSessionId}. NULL until a run pins it. */
    engine: text('engine', { enum: engineIds }),
    /**
     * The pinned version. Tenant- and agent-paired below as `sessions_agent_version_fk`; NULL is a
     * legacy, unversioned session.
     */
    agentVersionId: uuid('agent_version_id'),
    /** §19.5's Recent list label. NULL until something names the session. */
    title: text('title'),
    status: text('status', { enum: sessionStatuses }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The tenant index, and the exact shape §19.5's "Recent" list queries: this workspace,
    // newest first.
    index('sessions_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
    // Resume-by-engine-session-id, scoped to the tenant so one workspace can never resolve
    // another's session (§25). NULLs are distinct in PostgreSQL, so any number of sessions may
    // sit here without an engine session id.
    uniqueIndex('sessions_workspace_engine_session_key').on(
      table.workspaceId,
      table.engineSessionId,
    ),
    index('sessions_agent_idx').on(table.agentId),
    index('sessions_project_idx').on(table.projectId),
    index('sessions_user_idx').on(table.userId),
    index('sessions_owner_principal_idx').on(table.ownerPrincipalId),
    // The target `runs_session_workspace_fk` needs. `id` is already the primary key, so this
    // adds no new restriction on the data.
    // Declared as a table CONSTRAINT rather than a unique INDEX on purpose. drizzle-kit
    // emits every `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` before it emits any
    // `CREATE UNIQUE INDEX`, so a composite foreign key pointing at a unique *index*
    // fails the migration with "there is no unique constraint matching the given keys".
    // A constraint is emitted inside CREATE TABLE, which is early enough.
    unique('sessions_id_workspace_key').on(table.id, table.workspaceId),
    // §25, and the reason `agent_id` above carries no reference of its own. A single-column
    // `agent_id -> agents(id)` says only that the agent exists somewhere; the workspace_id
    // copy on this row could then disagree with the agent's, and nothing would stop it. The
    // pair is checked together, so the two copies cannot diverge.
    //
    // `CASCADE`, unlike `user_id`: §19.5 rule 3 promises the built-in General agent is
    // "editable and deletable like any other". `RESTRICT` would make any agent undeletable the
    // moment it was used once, which breaks that promise. The price is that deleting an agent
    // deletes its sessions and their runs; that trade is recorded in
    // docs/adr/W1-DB-01-schema-conventions.md.
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'sessions_agent_workspace_fk',
    }).onDelete('cascade'),
    // A version of this session's own agent in this workspace, so a session cannot pin another
    // agent's or another tenant's version. `NO ACTION`: a version is only deleted by its agent's
    // cascade, which deletes this session in the same statement. NULL skips the check (MATCH
    // SIMPLE), which is the legacy case.
    foreignKey({
      columns: [table.agentVersionId, table.agentId, table.workspaceId],
      foreignColumns: [agentVersions.id, agentVersions.agentId, agentVersions.workspaceId],
      name: 'sessions_agent_version_fk',
    }).onDelete('no action'),
    foreignKey({
      columns: [table.projectId, table.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'sessions_project_workspace_fk',
    }).onDelete('set null'),
    // §21 and §25: the person a session belongs to must hold a membership in the workspace the
    // session is in. `user_id` alone (the `users` reference above) only says the identity
    // exists globally, so without this a workspace could be handed a session owned by someone
    // who was never a member of it.
    //
    // `NO ACTION` is PostgreSQL's default, and on this constraint it is INDISTINGUISHABLE from
    // `RESTRICT`. Measured on PostgreSQL 17.11 (the probe is quoted in
    // docs/adr/W1-DB-01-schema-conventions.md decision 14): both actions install an AFTER ROW
    // trigger that fires at end of statement, so deleting a workspace — which cascades into
    // `memberships` AND `sessions` in the same statement — succeeds under both, and removing a
    // member who still owns a session is rejected by this constraint's name under both. The
    // only behaviour that separates them is deferrability, and it appears only if the
    // constraint is declared `DEFERRABLE`: `NO ACTION`'s `RI_FKey_noaction_del` trigger becomes
    // deferrable and moves to COMMIT, while `RESTRICT`'s `RI_FKey_restrict_del` stays
    // `tgdeferrable = f`. This constraint is NOT DEFERRABLE, so nothing observes that today.
    // `no action` is kept because it is the default and keeps the deferrable option open — not
    // because any behaviour depends on it. NO TEST DISCRIMINATES THE TWO, and none can while
    // the constraint is not deferrable; what the tests do hold is that this constraint EXISTS
    // and rejects (tenancy.test.ts's required-reference registry, and the two seed.test.ts
    // cases that name it).
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'sessions_member_workspace_fk',
    }).onDelete('no action'),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'sessions_owner_principal_workspace_fk',
    }).onDelete('no action'),
    oneOf('sessions_status_valid', table.status, sessionStatuses),
    oneOf('sessions_engine_valid', table.engine, engineIds),
    // `engine IS NULL AND engine_session_id IS NOT NULL` is unreachable, and is deliberately NOT a
    // CHECK, which is the exception docs/adr/FORMAL-P1-documented-row-invariants-are-checks.md asks
    // to be written down rather than assumed. drizzle-kit emits `ADD CONSTRAINT` in the same
    // migration that adds the column, before the backfill in 0025 can run, so the constraint would
    // reject every existing identified session at deploy time. The invariant is held by the single
    // writer instead — `recordReportedSessionIdentity` writes `engine` and `engine_session_id`
    // together — and `sessions.test.ts` regression-tests that pairing. #318 pins the engine at first
    // run and can make the column NOT NULL, at which point the pairing is structural.
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
