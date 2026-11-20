import { rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import {
  createIsolatedTestDatabase,
  runMigrationsPastStorageProof,
  type IsolatedTestDatabase,
} from './testing.js';
import {
  LEGACY_COLUMN_KEYS,
  OWNERSHIP_RELATIONS,
  PRINCIPAL_COLUMN_KEYS,
  createPriorMigrationsDir,
  insertLegacyOwnedRowsUnderShadowedSearchPath,
  insertLegacySources,
  newBackfillFixture,
  newLegacyWriter,
  postgresErrorCode,
  readLegacyOwnership,
  readWorkspaceOwnership,
  seedAnomalousProject,
  seedBackfillFixture,
  withClient,
  type PrincipalRow,
} from './workspace-principal-migration.test-support.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

async function seedPriorSchema(
  isolated: IsolatedTestDatabase,
  fixture: ReturnType<typeof newBackfillFixture>,
) {
  await withClient(isolated.url, (client) => seedBackfillFixture(client, fixture));
}

describe.skipIf(!hasDatabase)('0020 workspace principal backfill', () => {
  let isolated: IsolatedTestDatabase;
  let anomalous: IsolatedTestDatabase;
  let priorMigrationsDir: string | undefined;
  const fixture = newBackfillFixture();
  const { workspaceId, membershipId, apiKeyId } = fixture;

  beforeAll(async () => {
    priorMigrationsDir = await createPriorMigrationsDir(resolveMigrationsDir(process.env));
    isolated = await createIsolatedTestDatabase(
      'aw_principal_backfill',
      databaseUrl,
      priorMigrationsDir,
    );
    await seedPriorSchema(isolated, fixture);
    await runMigrationsPastStorageProof(isolated.url, resolveMigrationsDir(process.env));

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
    await withClient(isolated.url, async (client) => {
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
    });
  });

  it('maps every human-owned row to the exact same-workspace membership principal', async () => {
    await withClient(isolated.url, async (client) => {
      const principal = await client.query<{ id: string }>(
        `select id from workspace_principals where workspace_id = $1 and membership_id = $2`,
        [workspaceId, membershipId],
      );
      const principalId = principal.rows[0]?.id;
      expect(principalId).toEqual(expect.any(String));

      const ownership = await readWorkspaceOwnership(client, workspaceId);

      expect(ownership.map((row) => row.relation).sort()).toEqual(OWNERSHIP_RELATIONS);
      expect(ownership.every((row) => row.principal_id === principalId)).toBe(true);
    });
  });

  it('retains nullable compatibility columns and requires authoritative owner principals', async () => {
    await withClient(isolated.url, async (client) => {
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

      for (const key of LEGACY_COLUMN_KEYS) {
        expect(nullability.get(key), key).toBe('YES');
      }
      for (const key of PRINCIPAL_COLUMN_KEYS) {
        expect(nullability.get(key), key).toBe('NO');
      }
    });
  });

  it('keeps prior-version source and human ownership writes compatible after cutover', async () => {
    const writer = newLegacyWriter();
    const revokedAt = '2027-04-05T06:07:08.000Z';
    await withClient(isolated.url, async (client) => {
      await insertLegacySources(client, workspaceId, writer);
      await insertLegacyOwnedRowsUnderShadowedSearchPath(client, workspaceId, writer);

      const membershipPrincipal = await client.query<{ id: string }>(
        `select id from workspace_principals
          where workspace_id = $1 and membership_id = $2 and kind = 'membership'`,
        [workspaceId, writer.membershipId],
      );
      const principalId = membershipPrincipal.rows[0]?.id;
      expect(principalId).toMatch(/^[0-9a-f-]{36}$/u);
      const ownership = await readLegacyOwnership(client, writer);
      expect(ownership).toHaveLength(8);
      expect(ownership.every((row) => row.principal_id === principalId)).toBe(true);

      const apiKeyPrincipal = await client.query<{ revoked_at: string | null }>(
        `select revoked_at::text from workspace_principals
          where workspace_id = $1 and api_key_id = $2 and kind = 'api_key'`,
        [workspaceId, writer.apiKeyId],
      );
      expect(apiKeyPrincipal.rows).toEqual([{ revoked_at: null }]);
      await client.query(`update api_keys set revoked_at = $1 where id = $2`, [
        revokedAt,
        writer.apiKeyId,
      ]);
      const revokedPrincipal = await client.query<{ revoked_at: string | null }>(
        `select revoked_at::text from workspace_principals where api_key_id = $1`,
        [writer.apiKeyId],
      );
      expect(revokedPrincipal.rows).toEqual([{ revoked_at: '2027-04-05 06:07:08+00' }]);
    });
  });

  it('aborts and rolls back when a legacy project creator has no same-workspace membership', async () => {
    await withClient(anomalous.url, seedAnomalousProject);

    let migrationError: unknown;
    try {
      await runMigrations(
        { url: anomalous.url, maxConnections: 4 },
        resolveMigrationsDir(process.env),
      );
    } catch (error) {
      migrationError = error;
    }
    expect(postgresErrorCode(migrationError)).toBe('23514');

    await withClient(anomalous.url, async (inspector) => {
      const result = await inspector.query<{ present: boolean }>(
        `select exists (
           select 1 from information_schema.tables
            where table_schema = 'public' and table_name = 'workspace_principals'
         ) as present`,
      );
      expect(result.rows[0]?.present).toBe(false);
    });
  });
});
