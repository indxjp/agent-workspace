/**
 * The rollout-window re-backfill against real PostgreSQL. A pod older than per-version grants that
 * kept serving after 0083 ran could create or materialise a version without writing its
 * `agent_version_storage_grants` rows; that version fails closed until it is redeployed. The
 * database is migrated as far as the migration before the re-backfill, the window's leftovers are
 * seeded, and then the re-backfill copies the agent's current grants to its materialised version,
 * exactly as 0083 did, but only for a version that has no row at all and only for a connection that
 * already existed when the version was created: a connection recreated later under the same name is
 * another connection, and is never bound to an old version. A missing `TEST_DATABASE_URL` makes
 * `beforeAll` throw, so this suite fails instead of skipping.
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

/** The re-backfill's tag without its number, so a renumbering merge does not break this suite. */
const REBACKFILL = /^\d{4}_rebackfill_version_storage_grants$/u;
const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

interface Grant {
  readonly id: string;
  readonly connectionId: string;
  readonly prefix: string;
  readonly access: string;
}

describe('the rollout-window re-backfill of per-version storage grants', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const connections = { reports: crypto.randomUUID(), archive: crypto.randomUUID() };
  /** Recreated under the name `reports` after every version below was created. */
  const recreated = crypto.randomUUID();
  const grant = (connectionId: string, prefix: string): Grant => ({
    id: crypto.randomUUID(),
    connectionId,
    prefix,
    access: 'read',
  });
  // Materialised by an old pod after 0083: its version has no row.
  const window = {
    agentId: crypto.randomUUID(),
    v1: crypto.randomUUID(),
    v2: crypto.randomUUID(),
    grants: [grant(connections.reports, 'reports'), grant(connections.archive, 'archive')],
  };
  // Its version already has rows: a version written by a new pod is never touched.
  const current = {
    agentId: crypto.randomUUID(),
    v1: crypto.randomUUID(),
    stored: grant(connections.reports, 'reports'),
    grants: [grant(connections.reports, 'reports'), grant(connections.archive, 'archive')],
  };
  // An old pod rebound the version's folder by name to a connection recreated after the version.
  const rebound = {
    agentId: crypto.randomUUID(),
    v1: crypto.randomUUID(),
    grants: [grant(recreated, 'reports'), grant(connections.archive, 'archive')],
  };

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-rebackfill-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));
    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const at = journal.entries.findIndex((entry) => REBACKFILL.test(entry.tag));
    expect(at, 'the re-backfill migration is in the journal').toBeGreaterThan(0);
    const entries = journal.entries.slice(0, at);
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
      'aw_version_grants_rebackfill',
      process.env['TEST_DATABASE_URL'],
      priorMigrationsDir,
    );

    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Rollout-window workspace' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Rollout-window owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });

    // Raw SQL, so the seed does not follow later changes to the Drizzle tables. Every version is
    // created an hour ago; the original connections before that, the recreated one just now.
    const db = isolated.db;
    const connect = (id: string, name: string, createdAt: string) =>
      db.execute(sql`
        insert into storage_connections (id, workspace_id, name, provider, url, allowed_prefixes, created_at)
        values (${id}, ${workspaceId}, ${name}, 's3', 's3://bucket', array['reports', 'archive'], ${createdAt}::timestamptz)`);
    await connect(connections.reports, 'reports-old', '2026-01-01T00:00:00Z');
    await connect(connections.archive, 'archive', '2026-01-01T00:00:00Z');
    await connect(recreated, 'reports', new Date().toISOString());
    const seedAgent = async (
      agentId: string,
      name: string,
      versionIds: readonly string[],
      materialised: string,
    ) => {
      await db.execute(sql`
        insert into agents (id, workspace_id, name, instructions, permissions, owner_principal_id)
        values (${agentId}, ${workspaceId}, ${name}, '', ${JSON.stringify(PERMISSIONS)}::jsonb, ${principalId})`);
      for (const [index, versionId] of versionIds.entries()) {
        await db.execute(sql`
          insert into agent_versions (id, workspace_id, agent_id, number, summary, via, body, created_by_principal_id, created_at)
          values (${versionId}, ${workspaceId}, ${agentId}, ${index + 1}, 'v', 'aw-push', '{}'::jsonb, ${principalId}, now() - interval '1 hour')`);
      }
      await db.execute(
        sql`update agents set materialised_version_id = ${materialised} where id = ${agentId}`,
      );
    };
    const seedGrant = (agentId: string, row: Grant) =>
      db.execute(sql`
        insert into agent_storage_grants (id, workspace_id, agent_id, connection_id, prefix, access)
        values (${row.id}, ${workspaceId}, ${agentId}, ${row.connectionId}, ${row.prefix}, ${row.access})`);

    await seedAgent(window.agentId, 'window', [window.v1, window.v2], window.v2);
    for (const row of window.grants) await seedGrant(window.agentId, row);

    await seedAgent(current.agentId, 'current', [current.v1], current.v1);
    for (const row of current.grants) await seedGrant(current.agentId, row);
    await db.execute(sql`
      insert into agent_version_storage_grants (id, workspace_id, version_id, connection_id, prefix, access)
      values (${current.stored.id}, ${workspaceId}, ${current.v1}, ${current.stored.connectionId}, ${current.stored.prefix}, ${current.stored.access})`);

    await seedAgent(rebound.agentId, 'rebound', [rebound.v1], rebound.v1);
    for (const row of rebound.grants) await seedGrant(rebound.agentId, row);

    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);
  }, 300_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  /** The per-version rows of `versionIds`, by prefix. */
  const rowsOf = async (versionIds: readonly string[]) =>
    (
      await isolated.db.execute<{
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
        order by prefix`)
    ).rows.map((row) => ({ ...row }));

  const asRows = (versionId: string, grants: readonly Grant[]) =>
    [...grants]
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
      .map((row) => ({
        id: row.id,
        version_id: versionId,
        connection_id: row.connectionId,
        prefix: row.prefix,
        access: row.access,
      }));

  it('[US-STO-12][unit][sdk] gives a version materialised in the window its agent’s grants, and no other version any', async () => {
    expect(await rowsOf([window.v1, window.v2])).toEqual(asRows(window.v2, window.grants));
  });

  it('[US-STO-12][unit][sdk] leaves a version that already has rows as it is', async () => {
    expect(await rowsOf([current.v1])).toEqual(asRows(current.v1, [current.stored]));
  });

  it('[US-STO-12][unit][sdk] never binds a connection created after the version, so a recreated name stays unbound', async () => {
    expect(await rowsOf([rebound.v1])).toEqual(
      asRows(
        rebound.v1,
        rebound.grants.filter((row) => row.connectionId !== recreated),
      ),
    );
  });
});
