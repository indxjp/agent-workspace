/**
 * Migration 0083 against real PostgreSQL: the database is migrated as far as 0082 (the table
 * exists, empty), agents are seeded with grants and versions, and then 0083 copies each agent's
 * current grants to its materialised version, with the same row ids and the same connection ids.
 * Every other version, and an agent without a materialised version, gets no row. A missing
 * `TEST_DATABASE_URL` makes `beforeAll` throw, so this suite fails instead of skipping.
 */
// @story US-STO-12
import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const BACKFILL = '0083_backfill_version_storage_grants';
const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

describe('0083 per-version storage grants backfill', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const connections = { reports: crypto.randomUUID(), archive: crypto.randomUUID() };
  const lagging = {
    agentId: crypto.randomUUID(),
    v1: crypto.randomUUID(),
    v2: crypto.randomUUID(),
    grants: [
      {
        id: crypto.randomUUID(),
        connectionId: connections.reports,
        prefix: 'reports',
        access: 'read',
      },
      {
        id: crypto.randomUUID(),
        connectionId: connections.archive,
        prefix: 'archive',
        access: 'read-write',
      },
    ],
  };
  // Materialised at its oldest version while newer ones exist: only version 1 gets the rows.
  const pinnedOld = {
    agentId: crypto.randomUUID(),
    v1: crypto.randomUUID(),
    v2: crypto.randomUUID(),
    v3: crypto.randomUUID(),
    grants: [
      {
        id: crypto.randomUUID(),
        connectionId: connections.reports,
        prefix: 'reports',
        access: 'read',
      },
      {
        id: crypto.randomUUID(),
        connectionId: connections.archive,
        prefix: 'archive',
        access: 'read',
      },
    ],
  };
  const edited = {
    agentId: crypto.randomUUID(),
    v1: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  };

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-0083-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));
    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const entries = journal.entries.filter((entry) => entry.tag < BACKFILL);
    expect(entries.length).toBeLessThan(journal.entries.length);
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
      'aw_version_grants_migration',
      process.env['TEST_DATABASE_URL'],
      priorMigrationsDir,
    );

    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Pre-0083 workspace' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Pre-0083 owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });

    // Raw SQL, so the seed does not follow later changes to the Drizzle tables.
    const db = isolated.db;
    for (const [name, id] of Object.entries(connections)) {
      await db.execute(sql`
        insert into storage_connections (id, workspace_id, name, provider, url, allowed_prefixes)
        values (${id}, ${workspaceId}, ${name}, 's3', 's3://bucket', array['reports', 'archive'])`);
    }
    const seedAgent = async (agentId: string, name: string, versionIds: readonly string[]) => {
      await db.execute(sql`
        insert into agents (id, workspace_id, name, instructions, permissions, owner_principal_id)
        values (${agentId}, ${workspaceId}, ${name}, '', ${JSON.stringify(PERMISSIONS)}::jsonb, ${principalId})`);
      for (const [index, versionId] of versionIds.entries()) {
        await db.execute(sql`
          insert into agent_versions (id, workspace_id, agent_id, number, summary, via, body, created_by_principal_id)
          values (${versionId}, ${workspaceId}, ${agentId}, ${index + 1}, 'v', 'aw-push', '{}'::jsonb, ${principalId})`);
      }
    };
    const seedGrant = (
      agentId: string,
      grant: { id: string; connectionId: string; prefix: string; access: string },
    ) =>
      db.execute(sql`
        insert into agent_storage_grants (id, workspace_id, agent_id, connection_id, prefix, access)
        values (${grant.id}, ${workspaceId}, ${agentId}, ${grant.connectionId}, ${grant.prefix}, ${grant.access})`);

    await seedAgent(lagging.agentId, 'lagging', [lagging.v1, lagging.v2]);
    await db.execute(
      sql`update agents set materialised_version_id = ${lagging.v2} where id = ${lagging.agentId}`,
    );
    for (const grant of lagging.grants) await seedGrant(lagging.agentId, grant);

    await seedAgent(pinnedOld.agentId, 'pinned-old', [pinnedOld.v1, pinnedOld.v2, pinnedOld.v3]);
    await db.execute(
      sql`update agents set materialised_version_id = ${pinnedOld.v1} where id = ${pinnedOld.agentId}`,
    );
    for (const grant of pinnedOld.grants) await seedGrant(pinnedOld.agentId, grant);

    // An agent edited outside the version pipeline has no materialised version.
    await seedAgent(edited.agentId, 'edited', [edited.v1]);
    await seedGrant(edited.agentId, {
      id: edited.grantId,
      connectionId: connections.reports,
      prefix: 'reports',
      access: 'read',
    });

    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);
  }, 300_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  /** The rows 0083 wrote for `versionIds`. */
  const backfilled = (versionIds: readonly string[]) =>
    isolated.db.execute<{
      id: string;
      version_id: string;
      connection_id: string;
      prefix: string;
      access: string;
    }>(sql`
      select id, version_id, connection_id, prefix, access
      from agent_version_storage_grants
      where workspace_id = ${workspaceId}
        and version_id in (${sql.join(
          versionIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      order by prefix`);

  it('[US-STO-12][unit][sdk] copies the materialised version’s rows with the same ids, and no other version’s', async () => {
    const result = await backfilled([lagging.v1, lagging.v2, edited.v1]);

    expect(result.rows.map((row) => ({ ...row }))).toEqual(
      [...lagging.grants]
        .sort((a, b) => a.prefix.localeCompare(b.prefix))
        .map((grant) => ({
          id: grant.id,
          version_id: lagging.v2,
          connection_id: grant.connectionId,
          prefix: grant.prefix,
          access: grant.access,
        })),
    );
  });

  it('[US-STO-12][unit][sdk] copies to the materialised version even when newer versions exist', async () => {
    const result = await backfilled([pinnedOld.v1, pinnedOld.v2, pinnedOld.v3]);

    expect(result.rows.map((row) => ({ ...row }))).toEqual(
      [...pinnedOld.grants]
        .sort((a, b) => a.prefix.localeCompare(b.prefix))
        .map((grant) => ({
          id: grant.id,
          version_id: pinnedOld.v1,
          connection_id: grant.connectionId,
          prefix: grant.prefix,
          access: grant.access,
        })),
    );
  });
});
