import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';

export interface PrincipalRow {
  readonly id: string;
  readonly kind: string;
  readonly membership_id: string | null;
  readonly api_key_id: string | null;
  readonly activated_at: string;
  readonly revoked_at: string | null;
}

interface OwnershipRow {
  readonly relation: string;
  readonly principal_id: string | null;
}

/** Identifiers and timestamps of the fixture seeded before migration 0020 runs. */
interface BackfillFixture {
  readonly workspaceId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly apiKeyId: string;
  readonly agentId: string;
}

const MEMBERSHIP_CREATED_AT = '2024-01-02T03:04:05.000Z';
const API_KEY_CREATED_AT = '2024-02-03T04:05:06.000Z';
const API_KEY_REVOKED_AT = '2024-03-04T05:06:07.000Z';

export function newBackfillFixture(): BackfillFixture {
  return {
    workspaceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    apiKeyId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
  };
}

/** Compatibility columns that must stay nullable after the cutover. */
export const LEGACY_COLUMN_KEYS = [
  'agents.created_by',
  'files.created_by',
  'skills.created_by',
  'mcp_servers.created_by',
  'projects.created_by',
  'sessions.user_id',
  'shares.created_by',
];

/** Authoritative principal columns that must be NOT NULL after the cutover. */
export const PRINCIPAL_COLUMN_KEYS = [
  'agents.owner_principal_id',
  'files.owner_principal_id',
  'skills.owner_principal_id',
  'mcp_servers.owner_principal_id',
  'projects.owner_principal_id',
  'sessions.owner_principal_id',
  'shares.publisher_principal_id',
];

export const OWNERSHIP_RELATIONS = [
  'agents',
  'audit_events',
  'files',
  'mcp_servers',
  'projects',
  'sessions',
  'shares',
  'skills',
];

interface MigrationJournalFile {
  readonly entries: Array<{ readonly tag: string }>;
  readonly [key: string]: unknown;
}

function isMigrationJournalFile(value: unknown): value is MigrationJournalFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entries' in value &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'tag' in entry &&
        typeof entry.tag === 'string',
    )
  );
}

export function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      'code' in current &&
      typeof current.code === 'string'
    ) {
      return current.code;
    }
    if (typeof current !== 'object' || current === null || !('cause' in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

/** Connects, runs `use`, and always closes the client. */
export async function withClient<T>(
  connectionString: string,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** Copies every migration strictly before 0020 into a fresh temp directory. */
export async function createPriorMigrationsDir(migrationsDir: string): Promise<string> {
  const priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-0020-'));
  await mkdir(path.join(priorMigrationsDir, 'meta'));

  const journal: unknown = JSON.parse(
    await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  );
  if (!isMigrationJournalFile(journal)) {
    throw new Error('the migration journal does not contain string-tagged entries');
  }
  // Everything strictly BEFORE 0020 — not merely "not 0020" — so the fixture keeps meaning "the
  // schema as it stood immediately before 0020 shipped" no matter how many migrations have
  // landed after it since. Filtering by inequality alone would keep a later migration (say,
  // 0021) in this "prior" set; applying it here and then applying the real, full journal
  // afterwards would silently skip 0020 as an out-of-order insert (R-15 §3) — the drift bug
  // this very check exists to catch — for a reason that has nothing to do with 0020 itself.
  const cutoff = journal.entries.findIndex((entry) => entry.tag === '0020_sparkling_nova');
  if (cutoff === -1) throw new Error('0020_sparkling_nova is missing from the migration journal');
  const entries = journal.entries.slice(0, cutoff);
  await writeFile(
    path.join(priorMigrationsDir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  await Promise.all(
    entries.map((entry) =>
      cp(
        path.join(migrationsDir, `${entry.tag}.sql`),
        path.join(priorMigrationsDir, `${entry.tag}.sql`),
      ),
    ),
  );
  return priorMigrationsDir;
}

/** Seeds one workspace with a human-owned row in every ownership relation (pre-0020 schema). */
export async function seedBackfillFixture(
  client: pg.Client,
  fixture: BackfillFixture,
): Promise<void> {
  const { workspaceId, userId, membershipId, apiKeyId, agentId } = fixture;
  await client.query(
    `insert into workspaces (id, slug, name) values ($1, 'principal-backfill', 'Principal Backfill')`,
    [workspaceId],
  );
  await client.query(
    `insert into users (id, email, name) values ($1, 'principal-backfill@example.test', 'Principal Backfill')`,
    [userId],
  );
  await client.query(
    `insert into memberships (id, workspace_id, user_id, role, created_at)
         values ($1, $2, $3, 'owner', $4)`,
    [membershipId, workspaceId, userId, MEMBERSHIP_CREATED_AT],
  );
  await client.query(
    `insert into api_keys
           (id, workspace_id, name, role, key_prefix, key_hash, created_at, revoked_at)
         values ($1, $2, 'revoked automation', 'builder', 'awk_test', 'test-hash', $3, $4)`,
    [apiKeyId, workspaceId, API_KEY_CREATED_AT, API_KEY_REVOKED_AT],
  );
  await client.query(
    `insert into agents (id, workspace_id, name, instructions, permissions, created_by)
         values ($1, $2, 'Backfill agent', '', '{}'::jsonb, $3)`,
    [agentId, workspaceId, userId],
  );
  await client.query(
    `insert into files (workspace_id, path, kind, created_by)
         values ($1, 'backfill', 'folder', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into skills (workspace_id, name, skill_md, created_by)
         values ($1, 'backfill-skill', '# Backfill', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into mcp_servers
           (workspace_id, name, transport, command, auth_type, created_by)
         values ($1, 'Backfill MCP', 'stdio', 'true', 'none', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into projects (workspace_id, name, created_by)
         values ($1, 'Backfill project', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into sessions (workspace_id, user_id, agent_id)
         values ($1, $2, $3)`,
    [workspaceId, userId, agentId],
  );
  await client.query(
    `insert into shares
           (workspace_id, token, subject_type, subject_id, subject_label, visibility, created_by)
         values ($1, 'principal-backfill-token', 'agent', $2, 'Backfill agent', 'private', $3)`,
    [workspaceId, agentId, userId],
  );
  await client.query(
    `insert into audit_events
           (workspace_id, actor_user_id, actor_label, action, subject_id, subject_label)
         values ($1, $2, 'Principal Backfill', 'agent-changed', $3, 'Backfill agent')`,
    [workspaceId, userId, agentId],
  );
}

/** Seeds a project whose creator has no membership in its workspace (a backfill anomaly). */
export async function seedAnomalousProject(client: pg.Client): Promise<void> {
  const anomalousWorkspaceId = crypto.randomUUID();
  const anomalousUserId = crypto.randomUUID();
  await client.query(
    `insert into workspaces (id, slug, name) values ($1, 'principal-anomaly', 'Principal Anomaly')`,
    [anomalousWorkspaceId],
  );
  await client.query(
    `insert into users (id, email, name) values ($1, 'principal-anomaly@example.test', 'Principal Anomaly')`,
    [anomalousUserId],
  );
  await client.query(
    `insert into projects (workspace_id, name, created_by)
         values ($1, 'Anomalous project', $2)`,
    [anomalousWorkspaceId, anomalousUserId],
  );
}

/** Ownership of every relation in the backfilled workspace. */
export async function readWorkspaceOwnership(
  client: pg.Client,
  workspaceId: string,
): Promise<OwnershipRow[]> {
  const ownership = await client.query<OwnershipRow>(
    `select 'agents' as relation, owner_principal_id as principal_id from agents where workspace_id = $1
         union all select 'files', owner_principal_id from files where workspace_id = $1
         union all select 'skills', owner_principal_id from skills where workspace_id = $1
         union all select 'mcp_servers', owner_principal_id from mcp_servers where workspace_id = $1
         union all select 'projects', owner_principal_id from projects where workspace_id = $1
         union all select 'sessions', owner_principal_id from sessions where workspace_id = $1
         union all select 'shares', publisher_principal_id from shares where workspace_id = $1
         union all select 'audit_events', actor_principal_id from audit_events where workspace_id = $1`,
    [workspaceId],
  );
  return ownership.rows;
}

interface LegacyWriter {
  readonly userId: string;
  readonly membershipId: string;
  readonly apiKeyId: string;
  readonly agentId: string;
}

export function newLegacyWriter(): LegacyWriter {
  return {
    userId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    apiKeyId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
  };
}

/** Writes a user, membership and API key the way the pre-RF-101 source writers did. */
export async function insertLegacySources(
  client: pg.Client,
  workspaceId: string,
  writer: LegacyWriter,
): Promise<void> {
  await client.query(
    `insert into users (id, email, name)
         values ($1, 'legacy-writer@example.test', 'Legacy Writer')`,
    [writer.userId],
  );
  // Deliberately omit workspace_principals: this is the pre-RF-101 source-writer contract.
  await client.query(
    `insert into memberships (id, workspace_id, user_id, role)
         values ($1, $2, $3, 'builder')`,
    [writer.membershipId, workspaceId, writer.userId],
  );
  await client.query(
    `insert into api_keys (id, workspace_id, name, role, key_prefix, key_hash)
         values ($1, $2, 'legacy-writer-key', 'builder', 'awk_legacy', 'legacy-writer-hash')`,
    [writer.apiKeyId, workspaceId],
  );
}

/** Writes owned rows that omit every principal ownership column. */
async function insertLegacyOwnedRows(
  client: pg.Client,
  workspaceId: string,
  writer: LegacyWriter,
): Promise<void> {
  const { userId, agentId } = writer;
  await client.query(
    `insert into agents (id, workspace_id, name, instructions, permissions, created_by)
         values ($1, $2, 'Legacy writer agent', '', '{}'::jsonb, $3)`,
    [agentId, workspaceId, userId],
  );
  await client.query(
    `insert into files (workspace_id, path, kind, created_by)
         values ($1, 'legacy-writer-folder', 'folder', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into skills (workspace_id, name, skill_md, created_by)
         values ($1, 'legacy-writer-skill', '# Legacy', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into mcp_servers
           (workspace_id, name, transport, command, auth_type, created_by)
         values ($1, 'Legacy writer MCP', 'stdio', 'true', 'none', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into projects (workspace_id, name, created_by)
         values ($1, 'Legacy writer project', $2)`,
    [workspaceId, userId],
  );
  await client.query(
    `insert into sessions (workspace_id, user_id, agent_id)
         values ($1, $2, $3)`,
    [workspaceId, userId, agentId],
  );
  await client.query(
    `insert into shares
           (workspace_id, token, subject_type, subject_id, subject_label, visibility, created_by)
         values ($1, 'legacy-writer-token', 'agent', $2, 'Legacy writer agent', 'private', $3)`,
    [workspaceId, agentId, userId],
  );
  await client.query(
    `insert into audit_events
           (workspace_id, actor_user_id, actor_label, action, subject_id, subject_label)
         values ($1, $2, 'Legacy Writer', 'agent-changed', $3, 'Legacy writer agent')`,
    [workspaceId, userId, agentId],
  );
}

/**
 * Inserts the legacy owned rows while a caller-controlled search_path shadows
 * workspace_principals. The shadow would either receive writes or fail column lookup if a
 * compatibility trigger body relied on an unqualified workspace_principals name.
 */
export async function insertLegacyOwnedRowsUnderShadowedSearchPath(
  client: pg.Client,
  workspaceId: string,
  writer: LegacyWriter,
): Promise<void> {
  await client.query(`create temporary table workspace_principals (shadow text)`);
  await client.query(`set search_path = pg_temp, public`);
  // Compatibility triggers must derive only the exact same-workspace Membership principal from
  // the legacy human columns.
  await insertLegacyOwnedRows(client, workspaceId, writer);
  await client.query(`drop table pg_temp.workspace_principals`);
  await client.query(`set search_path = public, pg_catalog`);
}

export async function readLegacyOwnership(
  client: pg.Client,
  writer: LegacyWriter,
): Promise<OwnershipRow[]> {
  const ownership = await client.query<OwnershipRow>(
    `select 'agents' as relation, owner_principal_id as principal_id from agents where id = $1
         union all select 'files', owner_principal_id from files where path = 'legacy-writer-folder'
         union all select 'skills', owner_principal_id from skills where name = 'legacy-writer-skill'
         union all select 'mcp_servers', owner_principal_id from mcp_servers where name = 'Legacy writer MCP'
         union all select 'projects', owner_principal_id from projects where name = 'Legacy writer project'
         union all select 'sessions', owner_principal_id from sessions where agent_id = $1 and user_id = $2
         union all select 'shares', publisher_principal_id from shares where token = 'legacy-writer-token'
         union all select 'audit_events', actor_principal_id from audit_events where actor_user_id = $2`,
    [writer.agentId, writer.userId],
  );
  return ownership.rows;
}
