/**
 * The operator report of agent versions whose storage folders cannot be bound at run time
 * (`docs/operations/storage-grants-report.sql`, #1835 STO-507), run against real PostgreSQL. A run
 * of a version is refused with `run_storage_grant_unavailable` when the version grants more
 * `storage://` folders than it has `agent_version_storage_grants` rows: it was deployed before
 * grants were recorded per version, or a connection it grants was deleted. The report lists exactly
 * those versions, with the environments pointing at each and whether it is the agent's
 * materialised version, so an operator knows what to redeploy. A missing `TEST_DATABASE_URL` makes
 * `beforeAll` throw, so this suite fails instead of skipping.
 */
// @story US-STO-12
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPORT = readFileSync(
  fileURLToPath(new URL('../../../../docs/operations/storage-grants-report.sql', import.meta.url)),
  'utf8',
);

describe('the report of versions whose storage grants fail closed (PostgreSQL)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const versions = {
    /** Deployed before per-version grants, behind `production`: no row for its folder. */
    legacy: crypto.randomUUID(),
    /** Grants two folders and kept one row: the other connection was deleted. */
    partial: crypto.randomUUID(),
    /** Grants one folder and has its row: it runs. */
    bound: crypto.randomUUID(),
    /** Grants no storage folder at all. */
    plain: crypto.randomUUID(),
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_sto_507_report');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'report-ws', name: 'Report' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    const membershipId = crypto.randomUUID();
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });

    const db = isolated.db;
    const permissions = JSON.stringify({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    await db.execute(sql`
      insert into storage_connections (id, workspace_id, name, provider, url, allowed_prefixes)
      values (${connectionId}, ${workspaceId}, 'acme-data', 's3', 's3://bucket', array['reports', 'archive'])`);
    await db.execute(sql`
      insert into agents (id, workspace_id, name, instructions, permissions, owner_principal_id)
      values (${agentId}, ${workspaceId}, 'summarizer', '', ${permissions}::jsonb, ${principalId})`);
    const body = (paths: readonly string[]) =>
      JSON.stringify({
        definition: {
          resources: { files: paths.map((path) => ({ path, access: 'read' })) },
        },
      });
    const seedVersion = (id: string, number: number, paths: readonly string[]) =>
      db.execute(sql`
        insert into agent_versions (id, workspace_id, agent_id, number, summary, via, body, created_by_principal_id)
        values (${id}, ${workspaceId}, ${agentId}, ${number}, 'v', 'aw-push', ${body(paths)}::jsonb, ${principalId})`);
    const seedRow = (versionId: string, prefix: string) =>
      db.execute(sql`
        insert into agent_version_storage_grants (workspace_id, version_id, connection_id, prefix, access)
        values (${workspaceId}, ${versionId}, ${connectionId}, ${prefix}, 'read')`);

    await seedVersion(versions.legacy, 1, ['storage://acme-data/reports', 'shared/notes.md']);
    await seedVersion(versions.partial, 2, [
      'storage://acme-data/reports',
      'storage://old-data/archive',
    ]);
    await seedRow(versions.partial, 'reports');
    await seedVersion(versions.bound, 3, ['storage://acme-data/archive']);
    await seedRow(versions.bound, 'archive');
    await seedVersion(versions.plain, 4, ['shared/notes.md']);
    await db.execute(sql`
      update agents set materialised_version_id = ${versions.partial} where id = ${agentId}`);
    await db.execute(sql`
      insert into agent_version_pointers (workspace_id, agent_id, environment, version_id)
      values (${workspaceId}, ${agentId}, 'production', ${versions.legacy}),
             (${workspaceId}, ${agentId}, 'local', ${versions.partial})`);
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] lists each version that grants more folders than it has rows, and no other', async () => {
    const result = await isolated.db.execute<Record<string, unknown>>(sql.raw(REPORT));

    expect(result.rows.map((row) => ({ ...row }))).toEqual([
      {
        workspace: 'report-ws',
        agent_id: agentId,
        agent: 'summarizer',
        version: 1,
        materialised: false,
        environments: 'production',
        granted_folders: 1,
        bound_folders: 0,
      },
      {
        workspace: 'report-ws',
        agent_id: agentId,
        agent: 'summarizer',
        version: 2,
        materialised: true,
        environments: 'local',
        granted_folders: 2,
        bound_folders: 1,
      },
    ]);
  });
});
