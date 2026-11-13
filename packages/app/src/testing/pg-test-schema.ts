/**
 * A throwaway app schema in the PostgreSQL of `TEST_DATABASE_URL`, for this package's PostgreSQL
 * tests only: migrated by {@link migrateApp} from a generated migration, dropped afterwards.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { DefinedResource } from '../resource.js';
import { createAgentPanelSessionsSql } from '../db/agent-panel-sessions.js';
import { createAuditTableSql } from '../db/audit.js';
import { createChannelEventsSql } from '../db/channel-events.js';
import { createTableSql } from '../db/create-table-sql.js';
import { migrateApp, type AppMigrationOutcome } from '../db/migrate.js';
import { createRecipeTablesSql } from '../db/recipe-tables.js';
import { appSchemaName } from '../db/schema-name.js';

/** A migrated test schema and the database handle to use it with. */
export interface TestAppSchema {
  readonly appName: string;
  readonly db: NodePgDatabase;
  readonly firstRun: AppMigrationOutcome;
  readonly secondRun: AppMigrationOutcome;
  drop(): Promise<void>;
}

/**
 * Writes one migration creating the app kit's own tables (the audit table, the agent panel's
 * sessions, the recipe tables and the channel events) and `resources`, as the template and the
 * generator would.
 */
async function writeMigration(
  folder: string,
  appName: string,
  resources: readonly DefinedResource[],
): Promise<void> {
  await mkdir(path.join(folder, 'meta'), { recursive: true });
  const statements = [
    createAuditTableSql(appName),
    createAgentPanelSessionsSql(appName),
    createRecipeTablesSql(appName),
    createChannelEventsSql(appName),
    ...resources.map((resource) => createTableSql(resource, appName)),
  ];
  await writeFile(
    path.join(folder, '0000_init.sql'),
    statements.join('--> statement-breakpoint\n'),
  );
  await writeFile(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        { idx: 0, version: '7', when: 1_790_000_000_000, tag: '0000_init', breakpoints: true },
      ],
    }),
  );
}

/** Creates the app schema `app_t<random>` holding `resources`, migrating it twice. */
export async function createTestAppSchema(
  url: string,
  resources: readonly DefinedResource[],
): Promise<TestAppSchema> {
  const appName = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const folder = await mkdtemp(path.join(tmpdir(), 'aw-app-migrations-'));
  await writeMigration(folder, appName, resources);
  const firstRun = await migrateApp({ url, appName, migrationsFolder: folder });
  const secondRun = await migrateApp({ url, appName, migrationsFolder: folder });
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool);
  return {
    appName,
    db,
    firstRun,
    secondRun,
    async drop() {
      const failures: unknown[] = [];
      await db
        .execute(sql.raw(`drop schema if exists "${appSchemaName(appName)}" cascade`))
        .catch((error: unknown) => failures.push(error));
      await pool.end().catch((error: unknown) => failures.push(error));
      await rm(folder, { recursive: true, force: true }).catch((error: unknown) =>
        failures.push(error),
      );
      if (failures.length > 0)
        throw new AggregateError(failures, 'dropping the test schema failed');
    },
  };
}
