/**
 * `agent_panel_sessions`: the platform sessions the agent panel keeps per record, agent and person
 * (issue #1509), in the app's own schema. A second prompt by the same person about the same record
 * to the same agent continues their latest session, so the agent remembers their conversation.
 *
 * Each person has their own conversation: a platform session is the person's who started it, so two
 * people on one record never continue (or replace) each other's. A session is never overwritten:
 * when one can no longer be continued its successor is added beside it, so a run of the older one
 * that is still going stays the record's.
 *
 * The session id is a platform row's id, kept as text without a foreign key: app data never
 * references the platform's tables. Every statement is scoped by `workspace_id`, and every value
 * is a bound parameter.
 */
import { sql } from 'drizzle-orm';

import { quoted } from './columns.js';
import { appSchemaName } from './schema-name.js';
import type { AppSqlRunner } from './store.js';

/** The table's name, the same in every app schema. */
export const AGENT_PANEL_SESSIONS_TABLE = 'agent_panel_sessions';

/**
 * Which conversation a session belongs to: one record of one resource, one agent and one person,
 * in a workspace.
 */
export interface AgentPanelKey {
  readonly workspaceId: string;
  /** The resource's `name` (`ticket`). */
  readonly resource: string;
  readonly recordId: string;
  /** The panel's name for the agent, as `agentPanelRoutes` offers it (`triage`). */
  readonly agent: string;
  /** The person's principal id: each person continues only their own conversation. */
  readonly principalId: string;
}

/**
 * The panel's sessions: read the latest one of a key, add one to a key, and list every session a
 * record has had (whichever agent or person), which is how a run is known to belong to the record.
 */
export interface AgentPanelSessionStore {
  /** The key's latest session, or `null` when it has none. */
  find(key: AgentPanelKey): Promise<string | null>;
  /** Adds the session to the key, as its latest; a session it already has becomes its latest. */
  save(key: AgentPanelKey, sessionId: string): Promise<void>;
  sessionsOf(workspaceId: string, resource: string, recordId: string): Promise<readonly string[]>;
}

/**
 * The table as one deterministic SQL text, for the app's first migration.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function createAgentPanelSessionsSql(appName: string): string {
  const table = `${quoted(appSchemaName(appName))}.${quoted(AGENT_PANEL_SESSIONS_TABLE)}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  "workspace_id" text NOT NULL,',
    '  "resource" text NOT NULL,',
    '  "record_id" uuid NOT NULL,',
    '  "agent" text NOT NULL,',
    '  "principal_id" text NOT NULL,',
    '  "session_id" text NOT NULL,',
    '  "updated_at" timestamptz NOT NULL DEFAULT now(),',
    `  CONSTRAINT "${AGENT_PANEL_SESSIONS_TABLE}_pkey" PRIMARY KEY ("workspace_id", "resource", "record_id", "agent", "principal_id", "session_id")`,
    ');',
    '',
  ].join('\n');
}

/** What {@link agentPanelSessionsOf} takes. */
export interface AgentPanelSessionsOptions {
  readonly db: AppSqlRunner;
  /** The app's name key; the table lives in the schema `app_<name>`. */
  readonly appName: string;
}

function sessionIdOf(row: Record<string, unknown> | undefined): string | null {
  const value = row?.['session_id'];
  return typeof value === 'string' ? value : null;
}

/**
 * The panel's sessions over PostgreSQL.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function agentPanelSessionsOf(options: AgentPanelSessionsOptions): AgentPanelSessionStore {
  const table = sql.raw(
    `${quoted(appSchemaName(options.appName))}.${quoted(AGENT_PANEL_SESSIONS_TABLE)}`,
  );
  const { db } = options;
  return {
    async find(key) {
      const { rows } = await db.execute(
        sql`SELECT "session_id" FROM ${table} WHERE "workspace_id" = ${key.workspaceId} AND "resource" = ${key.resource} AND "record_id" = ${key.recordId} AND "agent" = ${key.agent} AND "principal_id" = ${key.principalId} ORDER BY "updated_at" DESC, "session_id" DESC LIMIT 1`,
      );
      return sessionIdOf(rows[0]);
    },
    async save(key, sessionId) {
      await db.execute(
        sql`INSERT INTO ${table} ("workspace_id", "resource", "record_id", "agent", "principal_id", "session_id", "updated_at") VALUES (${key.workspaceId}, ${key.resource}, ${key.recordId}, ${key.agent}, ${key.principalId}, ${sessionId}, clock_timestamp()) ON CONFLICT ("workspace_id", "resource", "record_id", "agent", "principal_id", "session_id") DO UPDATE SET "updated_at" = clock_timestamp()`,
      );
    },
    async sessionsOf(workspaceId, resource, recordId) {
      const { rows } = await db.execute(
        sql`SELECT DISTINCT "session_id" FROM ${table} WHERE "workspace_id" = ${workspaceId} AND "resource" = ${resource} AND "record_id" = ${recordId}`,
      );
      return rows.map(sessionIdOf).filter((id): id is string => id !== null);
    },
  };
}
