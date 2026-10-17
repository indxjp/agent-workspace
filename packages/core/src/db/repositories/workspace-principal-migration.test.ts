import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

interface PrincipalRow {
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

function postgresErrorCode(error: unknown): string | undefined {
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

describe.skipIf(!hasDatabase)('0020 workspace principal backfill', () => {
  let isolated: IsolatedTestDatabase;
  let anomalous: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const membershipCreatedAt = '2024-01-02T03:04:05.000Z';
  const apiKeyCreatedAt = '2024-02-03T04:05:06.000Z';
  const apiKeyRevokedAt = '2024-03-04T05:06:07.000Z';

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-0020-'));
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

    isolated = await createIsolatedTestDatabase(
      'aw_principal_backfill',
      databaseUrl,
      priorMigrationsDir,
    );
    const client = new pg.Client({ connectionString: isolated.url });
    await client.connect();
    try {
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
        [membershipId, workspaceId, userId, membershipCreatedAt],
      );
      await client.query(
        `insert into api_keys
           (id, workspace_id, name, role, key_prefix, key_hash, created_at, revoked_at)
         values ($1, $2, 'revoked automation', 'builder', 'awk_test', 'test-hash', $3, $4)`,
        [apiKeyId, workspaceId, apiKeyCreatedAt, apiKeyRevokedAt],
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
    } finally {
      await client.end();
    }
    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);

    anomalous = await createIsolatedTestDatabase(
      'aw_principal_anomaly',
      databaseUrl,
      priorMigrationsDir,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([isolated?.close(), anomalous?.close()]);
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  it('creates one principal per source and preserves lifecycle timestamps', async () => {
    const client = new pg.Client({ connectionString: isolated.url });
    await client.connect();
    try {
      const result = await client.query<PrincipalRow>(
        `select id, kind, membership_id, api_key_id,
                activated_at::text, revoked_at::text
           from workspace_principals
          where workspace_id = $1
          order by kind`,
        [workspaceId],
      );

      const lifecycleRows = result.rows.map(({ id, ...row }) => {
        expect(id).toMatch(/^[0-9a-f-]{36}$/u);
        return row;
      });
      expect(lifecycleRows).toEqual([
        {
          kind: 'api_key',
          membership_id: null,
          api_key_id: apiKeyId,
          activated_at: '2024-02-03 04:05:06+00',
          revoked_at: '2024-03-04 05:06:07+00',
        },
        {
          kind: 'membership',
          membership_id: membershipId,
          api_key_id: null,
          activated_at: '2024-01-02 03:04:05+00',
          revoked_at: null,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it('maps every human-owned row to the exact same-workspace membership principal', async () => {
    const client = new pg.Client({ connectionString: isolated.url });
    await client.connect();
    try {
      const principal = await client.query<{ id: string }>(
        `select id from workspace_principals where workspace_id = $1 and membership_id = $2`,
        [workspaceId, membershipId],
      );
      const principalId = principal.rows[0]?.id;
      expect(principalId).toEqual(expect.any(String));

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

      expect(ownership.rows.map((row) => row.relation).sort()).toEqual([
        'agents',
        'audit_events',
        'files',
        'mcp_servers',
        'projects',
        'sessions',
        'shares',
        'skills',
      ]);
      expect(ownership.rows.every((row) => row.principal_id === principalId)).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('retains nullable compatibility columns and requires authoritative owner principals', async () => {
    const client = new pg.Client({ connectionString: isolated.url });
    await client.connect();
    try {
      const result = await client.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
      }>(
        `select table_name, column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public'
            and (table_name, column_name) in (
              ('agents', 'created_by'), ('files', 'created_by'),
              ('skills', 'created_by'), ('mcp_servers', 'created_by'),
              ('projects', 'created_by'), ('sessions', 'user_id'),
              ('shares', 'created_by'), ('agents', 'owner_principal_id'),
              ('files', 'owner_principal_id'), ('skills', 'owner_principal_id'),
              ('mcp_servers', 'owner_principal_id'), ('projects', 'owner_principal_id'),
              ('sessions', 'owner_principal_id'), ('shares', 'publisher_principal_id')
            )`,
      );
      const nullability = new Map(
        result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.is_nullable]),
      );

      for (const key of [
        'agents.created_by',
        'files.created_by',
        'skills.created_by',
        'mcp_servers.created_by',
        'projects.created_by',
        'sessions.user_id',
        'shares.created_by',
      ]) {
        expect(nullability.get(key), key).toBe('YES');
      }
      for (const key of [
        'agents.owner_principal_id',
        'files.owner_principal_id',
        'skills.owner_principal_id',
        'mcp_servers.owner_principal_id',
        'projects.owner_principal_id',
        'sessions.owner_principal_id',
        'shares.publisher_principal_id',
      ]) {
        expect(nullability.get(key), key).toBe('NO');
      }
    } finally {
      await client.end();
    }
  });

  it('keeps prior-version source and human ownership writes compatible after cutover', async () => {
    const legacyUserId = crypto.randomUUID();
    const legacyMembershipId = crypto.randomUUID();
    const legacyApiKeyId = crypto.randomUUID();
    const legacyAgentId = crypto.randomUUID();
    const revokedAt = '2027-04-05T06:07:08.000Z';
    const client = new pg.Client({ connectionString: isolated.url });
    await client.connect();
    try {
      await client.query(
        `insert into users (id, email, name)
         values ($1, 'legacy-writer@example.test', 'Legacy Writer')`,
        [legacyUserId],
      );
      // Deliberately omit workspace_principals: this is the pre-RF-101 source-writer contract.
      await client.query(
        `insert into memberships (id, workspace_id, user_id, role)
         values ($1, $2, $3, 'builder')`,
        [legacyMembershipId, workspaceId, legacyUserId],
      );
      await client.query(
        `insert into api_keys (id, workspace_id, name, role, key_prefix, key_hash)
         values ($1, $2, 'legacy-writer-key', 'builder', 'awk_legacy', 'legacy-writer-hash')`,
        [legacyApiKeyId, workspaceId],
      );

      // A caller-controlled search_path must not redirect compatibility-trigger reads or writes.
      // This shadow would either receive writes or fail column lookup if a function body or call
      // relied on an unqualified workspace_principals name.
      await client.query(`create temporary table workspace_principals (shadow text)`);
      await client.query(`set search_path = pg_temp, public`);

      // Deliberately omit every principal ownership column. Compatibility triggers must derive
      // only the exact same-workspace Membership principal from the legacy human columns.
      await client.query(
        `insert into agents (id, workspace_id, name, instructions, permissions, created_by)
         values ($1, $2, 'Legacy writer agent', '', '{}'::jsonb, $3)`,
        [legacyAgentId, workspaceId, legacyUserId],
      );
      await client.query(
        `insert into files (workspace_id, path, kind, created_by)
         values ($1, 'legacy-writer-folder', 'folder', $2)`,
        [workspaceId, legacyUserId],
      );
      await client.query(
        `insert into skills (workspace_id, name, skill_md, created_by)
         values ($1, 'legacy-writer-skill', '# Legacy', $2)`,
        [workspaceId, legacyUserId],
      );
      await client.query(
        `insert into mcp_servers
           (workspace_id, name, transport, command, auth_type, created_by)
         values ($1, 'Legacy writer MCP', 'stdio', 'true', 'none', $2)`,
        [workspaceId, legacyUserId],
      );
      await client.query(
        `insert into projects (workspace_id, name, created_by)
         values ($1, 'Legacy writer project', $2)`,
        [workspaceId, legacyUserId],
      );
      await client.query(
        `insert into sessions (workspace_id, user_id, agent_id)
         values ($1, $2, $3)`,
        [workspaceId, legacyUserId, legacyAgentId],
      );
      await client.query(
        `insert into shares
           (workspace_id, token, subject_type, subject_id, subject_label, visibility, created_by)
         values ($1, 'legacy-writer-token', 'agent', $2, 'Legacy writer agent', 'private', $3)`,
        [workspaceId, legacyAgentId, legacyUserId],
      );
      await client.query(
        `insert into audit_events
           (workspace_id, actor_user_id, actor_label, action, subject_id, subject_label)
         values ($1, $2, 'Legacy Writer', 'agent-changed', $3, 'Legacy writer agent')`,
        [workspaceId, legacyUserId, legacyAgentId],
      );
      await client.query(`drop table pg_temp.workspace_principals`);
      await client.query(`set search_path = public, pg_catalog`);

      const membershipPrincipal = await client.query<{ id: string }>(
        `select id from workspace_principals
          where workspace_id = $1 and membership_id = $2 and kind = 'membership'`,
        [workspaceId, legacyMembershipId],
      );
      const principalId = membershipPrincipal.rows[0]?.id;
      expect(principalId).toMatch(/^[0-9a-f-]{36}$/u);
      const ownership = await client.query<OwnershipRow>(
        `select 'agents' as relation, owner_principal_id as principal_id from agents where id = $1
         union all select 'files', owner_principal_id from files where path = 'legacy-writer-folder'
         union all select 'skills', owner_principal_id from skills where name = 'legacy-writer-skill'
         union all select 'mcp_servers', owner_principal_id from mcp_servers where name = 'Legacy writer MCP'
         union all select 'projects', owner_principal_id from projects where name = 'Legacy writer project'
         union all select 'sessions', owner_principal_id from sessions where agent_id = $1 and user_id = $2
         union all select 'shares', publisher_principal_id from shares where token = 'legacy-writer-token'
         union all select 'audit_events', actor_principal_id from audit_events where actor_user_id = $2`,
        [legacyAgentId, legacyUserId],
      );
      expect(ownership.rows).toHaveLength(8);
      expect(ownership.rows.every((row) => row.principal_id === principalId)).toBe(true);

      const apiKeyPrincipal = await client.query<{ revoked_at: string | null }>(
        `select revoked_at::text from workspace_principals
          where workspace_id = $1 and api_key_id = $2 and kind = 'api_key'`,
        [workspaceId, legacyApiKeyId],
      );
      expect(apiKeyPrincipal.rows).toEqual([{ revoked_at: null }]);
      await client.query(`update api_keys set revoked_at = $1 where id = $2`, [
        revokedAt,
        legacyApiKeyId,
      ]);
      const revokedPrincipal = await client.query<{ revoked_at: string | null }>(
        `select revoked_at::text from workspace_principals where api_key_id = $1`,
        [legacyApiKeyId],
      );
      expect(revokedPrincipal.rows).toEqual([{ revoked_at: '2027-04-05 06:07:08+00' }]);
    } finally {
      await client.end();
    }
  });

  it('aborts and rolls back when a legacy project creator has no same-workspace membership', async () => {
    const anomalousWorkspaceId = crypto.randomUUID();
    const anomalousUserId = crypto.randomUUID();
    const client = new pg.Client({ connectionString: anomalous.url });
    await client.connect();
    try {
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
    } finally {
      await client.end();
    }

    let migrationError: unknown;
    try {
      await runMigrations({ url: anomalous.url, maxConnections: 4 }, resolveMigrationsDir());
    } catch (error) {
      migrationError = error;
    }
    expect(postgresErrorCode(migrationError)).toBe('23514');

    const inspector = new pg.Client({ connectionString: anomalous.url });
    await inspector.connect();
    try {
      const result = await inspector.query<{ present: boolean }>(
        `select exists (
           select 1 from information_schema.tables
            where table_schema = 'public' and table_name = 'workspace_principals'
         ) as present`,
      );
      expect(result.rows[0]?.present).toBe(false);
    } finally {
      await inspector.end();
    }
  });
});
