/**
 * `audit_events` — the audit trail of spec §36 (§27).
 *
 * §36 gives the action list verbatim and one rendered line — "Ito changed Customer Support
 * Agent / 2 minutes ago" — and says "No SIEM product needs to be built." The columns are
 * exactly what that sentence needs and nothing more: who, what, to which thing, when.
 *
 * Three decisions this file takes, each of which could have gone the other way:
 *
 *   * **The labels are stored, not joined.** `actor_label` and `subject_label` are the names as
 *     they were at the time. This is the same argument `runs.model` won under W1-DB-01
 *     decision 6: an audit line that changes retroactively — because the agent was renamed, or
 *     the user was deleted — is not a record. `actor_user_id` is kept alongside for linking and
 *     goes NULL when the user does; the line still reads.
 *   * **`subject_id` is `text`, not `uuid`, and carries no foreign key.** The subject of
 *     "agent deleted" does not exist by the time anybody reads the row, so a reference to it
 *     cannot be declared. Typing it `text` says that honestly instead of dressing a dead
 *     identifier up as a live reference.
 *
 *     This column is `tenancy.test.ts`'s `NON_REFERENCE_ID_COLUMNS['audit_events.subject_id']`,
 *     and it is declared there with this reason and its SQL type. It was NOT free of that
 *     obligation while the rule read `getSQLType() === 'uuid'`: typing the column `text` used
 *     to remove it from what the gate inspected at all, which would have let a later table
 *     carry an unpaired cross-tenant reference by doing the same thing. That is fixed — the
 *     rule is now over every `*_id` column at any type — so the `text` typing buys honesty
 *     about a dead identifier and nothing else. It does not make the rule stricter, and an
 *     earlier revision of this comment claimed it did.
 *   * **There is no metadata JSONB — with one narrow, typed exception.** §36's own first
 *     instruction after the list is "Do not log secrets", and a free-form blob on an audit row is
 *     where a request body ends up. Anything §36 does not name is not recorded. The exception is
 *     `details`: it holds ONLY `AgentCreatedAuditDetails` (issue #1847) on an `agent-created` row
 *     or `AgentChangedAuditDetails` (issue #1851) on an `agent-changed` row, is validated by that
 *     action's strict contracts schema before every write, and a CHECK refuses it on any other
 *     action. It is never a request body or a secret. The constraint keeps its first name.
 *
 * The row is immutable, so it has `created_at` and no `updated_at`.
 */
import {
  AUDIT_ACTIONS,
  type AgentChangedAuditDetails,
  type AgentCreatedAuditDetails,
  type AuditAction,
} from '@indx-workspace/contracts/observability';
import { check, foreignKey, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

/** Spec §36's control-plane actions: the list lives in contracts and the CHECK below derives from it. */
export { AUDIT_ACTIONS as auditActions, type AuditAction };

export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * Who acted, when that is still resolvable. `SET NULL` rather than `RESTRICT`: "user
     * deleted" is itself on §36's list, so a trail that forbade deleting an audited user would
     * forbid the very action it exists to record.
     */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorPrincipalId: uuid('actor_principal_id'),
    /** §36's "Ito". The actor's name at the time — or how a non-user actor identified itself. */
    actorLabel: text('actor_label').notNull(),
    action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
    /** The subject's identifier at the time, as text. NULL for an action with no one subject. */
    subjectId: text('subject_id'),
    /** §36's "Customer Support Agent". The subject's name at the time. */
    subjectLabel: text('subject_label').notNull(),
    /** Only an `agent-created` or `agent-changed` row has details; see the header and the CHECK below. */
    details: jsonb('details').$type<AgentCreatedAuditDetails | AgentChangedAuditDetails>(),
    createdAt: createdAt(),
  },
  (table) => [
    // The tenant index, and the exact shape §36's screen queries: this workspace, newest first.
    index('audit_events_workspace_created_idx').on(table.workspaceId, table.createdAt),
    // "Everything this person did", which the index above cannot serve.
    index('audit_events_actor_idx').on(table.actorUserId),
    index('audit_events_actor_principal_idx').on(table.actorPrincipalId),
    // PostgreSQL can clear only the nullable actor principal in this tenant-paired FK with
    // `ON DELETE SET NULL (actor_principal_id)`, preserving the required workspace id and the
    // immutable label snapshot. Drizzle's FK DSL cannot represent a column-list SET NULL action,
    // so migration 0020 adds that action explicitly while generated metadata remains `NO ACTION`.
    foreignKey({
      columns: [table.workspaceId, table.actorPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'audit_events_actor_principal_workspace_fk',
    }),
    oneOf('audit_events_action_valid', table.action, AUDIT_ACTIONS),
    // The name is the first one (issue #1847); the body now also admits `agent-changed` (#1851).
    check(
      'audit_events_details_only_agent_created',
      sql`${table.details} is null or ${table.action} = 'agent-created' or ${table.action} = 'agent-changed'`,
    ),
    check('audit_events_actor_label_not_blank', sql`length(btrim(${table.actorLabel})) > 0`),
    check('audit_events_subject_label_not_blank', sql`length(btrim(${table.subjectLabel})) > 0`),
    // If a subject id is recorded at all it is one of this schema's ids, so it has that shape.
    // A row that stores something else in this column is a row whose link will not resolve.
    check(
      'audit_events_subject_id_shape',
      sql`${table.subjectId} is null or ${table.subjectId} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`,
    ),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
