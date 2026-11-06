/**
 * `app_audit_events`: one row per write to an audited resource, in the app's own schema (issue
 * #1502). It names the fields a write changed, never their values, and the run an agent wrote in.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { quoted } from './columns.js';
import { appSchemaName } from './schema-name.js';

/** The audit table's name, the same in every app schema. */
export const AUDIT_TABLE = 'app_audit_events';

const ACTION_CHECK = `"action" IN ('create', 'update', 'delete')`;
const VIA_CHECK = `"via" IN ('person', 'agent')`;
/** Every agent write carries the run it was made in (F-10): a row without one is refused. */
const AGENT_RUN_CHECK = `"via" <> 'agent' OR "run_id" IS NOT NULL`;

/**
 * The Drizzle table of an app's audit events, for reading them back.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function appAuditTable(appName: string) {
  return pgSchema(appSchemaName(appName)).table(
    AUDIT_TABLE,
    {
      id: uuid('id').primaryKey().defaultRandom(),
      workspace_id: text('workspace_id').notNull(),
      actor: text('actor').notNull(),
      via: text('via', { enum: ['person', 'agent'] }).notNull(),
      run_id: text('run_id'),
      resource: text('resource').notNull(),
      record_id: uuid('record_id').notNull(),
      action: text('action', { enum: ['create', 'update', 'delete'] }).notNull(),
      fields: text('fields').array().notNull(),
      at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    },
    (table) => [
      index(`${AUDIT_TABLE}_list_idx`).on(table.workspace_id, table.at.desc(), table.id.desc()),
      check(`${AUDIT_TABLE}_action_check`, sql.raw(ACTION_CHECK)),
      check(`${AUDIT_TABLE}_via_check`, sql.raw(VIA_CHECK)),
      check(`${AUDIT_TABLE}_agent_run_check`, sql.raw(AGENT_RUN_CHECK)),
    ],
  );
}

/**
 * The audit table as one deterministic SQL text, for the app's first migration.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function createAuditTableSql(appName: string): string {
  const table = `${quoted(appSchemaName(appName))}.${quoted(AUDIT_TABLE)}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),',
    '  "workspace_id" text NOT NULL,',
    '  "actor" text NOT NULL,',
    '  "via" text NOT NULL,',
    '  "run_id" text,',
    '  "resource" text NOT NULL,',
    '  "record_id" uuid NOT NULL,',
    '  "action" text NOT NULL,',
    '  "fields" text[] NOT NULL,',
    '  "at" timestamptz NOT NULL DEFAULT now(),',
    `  CONSTRAINT "${AUDIT_TABLE}_action_check" CHECK (${ACTION_CHECK}),`,
    `  CONSTRAINT "${AUDIT_TABLE}_via_check" CHECK (${VIA_CHECK}),`,
    `  CONSTRAINT "${AUDIT_TABLE}_agent_run_check" CHECK (${AGENT_RUN_CHECK})`,
    ');',
    `CREATE INDEX IF NOT EXISTS "${AUDIT_TABLE}_list_idx" ON ${table} ("workspace_id", "at" DESC, "id" DESC);`,
    '',
  ].join('\n');
}
