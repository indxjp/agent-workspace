/**
 * `triggers` — what starts a run without a person at the keyboard (ADR-0144). A trigger targets one
 * agent and is either a `webhook` (a URL whose secret is the whole authentication of the ingress)
 * or a `schedule` (a five-field cron expression in an IANA time zone).
 *
 * `secret_hash` is the SHA-256 hex of the webhook URL secret (D2); the secret itself is shown once
 * and never stored. A schedule has no secret. `cron` and `timezone` are validated with croner in
 * `apps/web` (D6), not here.
 *
 * `owner_principal_id` is the principal every firing runs as (D3). Its foreign key is NO ACTION:
 * removing the owner must not delete the trigger silently, so the owner stays until the trigger is
 * reassigned or removed.
 */
import {
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { agents } from './agents.js';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { workspacePrincipals } from './workspace-principals.js';
import { workspaces } from './workspaces.js';

export const triggerKinds = ['webhook', 'schedule'] as const;
export type TriggerKind = (typeof triggerKinds)[number];

export const triggers = pgTable(
  'triggers',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `triggers_agent_workspace_fk`; no reference of its own. */
    agentId: uuid('agent_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: triggerKinds }).notNull(),
    /** The prompt of each firing; its only substitution is `{{body}}` (ADR-0144 D1). */
    promptTemplate: text('prompt_template').notNull(),
    /** `schedule` only: five-field cron expression. */
    cron: text('cron'),
    /** `schedule` only: IANA time zone the cron expression is read in. */
    timezone: text('timezone'),
    enabled: boolean('enabled').notNull().default(true),
    /** The JSON Schema every run of this trigger answers in (ADR-0154). Opaque here: the contract checks it. */
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    /** The caller every run of this trigger acts for (ADR-0156); validated by the contract. */
    subject: text('subject'),
    /** Tenant-paired below as `triggers_owner_workspace_fk`; no reference of its own. */
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    /** `webhook` only: SHA-256 hex of the URL secret. The secret itself is never stored. */
    secretHash: text('secret_hash'),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true, mode: 'date' }),
    /**
     * `schedule` only: when counting due slots last restarted, set when the trigger is enabled again
     * or its cron or time zone changes, so a schedule owes no run for windows before then (ADR-0144).
     */
    scheduleFrom: timestamp('schedule_from', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The target a tenant-paired reference to a trigger needs (`trigger_deliveries`).
    unique('triggers_workspace_id_key').on(table.workspaceId, table.id),
    uniqueIndex('triggers_workspace_name_key').on(table.workspaceId, table.name),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'triggers_agent_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'triggers_owner_workspace_fk',
    }),
    oneOf('triggers_kind_valid', table.kind, triggerKinds),
    check(
      'triggers_secret_hash_sha256_hex',
      sql`${table.secretHash} is null or ${table.secretHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'triggers_kind_shape',
      sql`(${table.kind} = 'webhook' and ${table.secretHash} is not null and ${table.cron} is null and ${table.timezone} is null)
        or (${table.kind} = 'schedule' and ${table.secretHash} is null and ${table.cron} is not null and ${table.timezone} is not null)`,
    ),
  ],
);

export type Trigger = typeof triggers.$inferSelect;
export type NewTrigger = typeof triggers.$inferInsert;
