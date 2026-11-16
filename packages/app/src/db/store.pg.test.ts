/**
 * `storeOf` against a real PostgreSQL: the conformance suite `memoryStoreOf` passes, on an
 * `app_t<random>` schema that `migrateApp` creates from the generated SQL and the suite drops.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONFORMANCE_RESOURCES, describeResourceStoreConformance } from '../testing/conformance.js';
import { fakePerson } from '../testing/fake-person.js';
import { createTestAppSchema, type TestAppSchema } from '../testing/pg-test-schema.js';
import { appAuditTable } from './audit.js';
import { migrateApp } from './migrate.js';
import { storeOf } from './store.js';
import { tablesOf } from './tables.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const url = rawUrl === undefined || rawUrl.trim() === '' ? undefined : rawUrl;

if (url === undefined) {
  console.warn(
    '[db/store.pg.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so storeOf and migrateApp ' +
      'were NOT exercised against a real PostgreSQL. A green result without it says nothing ' +
      'about the PostgreSQL store.',
  );
}

describe.skipIf(url === undefined)('storeOf against real PostgreSQL', () => {
  let schema: TestAppSchema | undefined;
  const ready = (): TestAppSchema => {
    if (schema === undefined) throw new Error('the test schema was not created');
    return schema;
  };

  beforeAll(async () => {
    schema = await createTestAppSchema(url ?? '', CONFORMANCE_RESOURCES);
  });

  afterAll(async () => {
    await schema?.drop();
  });

  it('migrates once, and a second run applies nothing', () => {
    expect(ready().firstRun).toEqual({ applied: 1, ledgerTotal: 1 });
    expect(ready().secondRun).toEqual({ applied: 0, ledgerTotal: 1 });
  });

  it('refuses a migration older than one already applied, which Drizzle would skip', async () => {
    const appName = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const folder = await mkdtemp(path.join(tmpdir(), 'aw-app-drift-'));
    const journal = (entries: readonly (readonly [string, number])[]): string =>
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: entries.map(([tag, when], idx) => ({
          idx,
          version: '7',
          when,
          tag,
          breakpoints: true,
        })),
      });
    try {
      await mkdir(path.join(folder, 'meta'));
      await writeFile(
        path.join(folder, '0001_b.sql'),
        `CREATE TABLE "app_${appName}"."b" ("n" int);`,
      );
      await writeFile(path.join(folder, 'meta', '_journal.json'), journal([['0001_b', 2000]]));
      const options = { url: url ?? '', appName, migrationsFolder: folder };
      expect(await migrateApp(options)).toEqual({ applied: 1, ledgerTotal: 1 });
      await writeFile(
        path.join(folder, '0000_a.sql'),
        `CREATE TABLE "app_${appName}"."a" ("n" int);`,
      );
      await writeFile(
        path.join(folder, 'meta', '_journal.json'),
        journal([
          ['0000_a', 1000],
          ['0001_b', 2000],
        ]),
      );
      await expect(migrateApp(options)).rejects.toThrow(/migration drift/u);
      await expect(migrateApp({ ...options, appName: 'Not A Name' })).rejects.toThrow(RangeError);
    } finally {
      await ready().db.execute(sql.raw(`drop schema if exists "app_${appName}" cascade`));
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('migrates as a role that owns only its schema, with no CREATE on the database', async () => {
    const appName = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const role = `app_${appName}`;
    const password = crypto.randomUUID();
    const folder = await mkdtemp(path.join(tmpdir(), 'aw-app-role-'));
    const { db } = ready();
    try {
      // As the deploy role job does: the role, and the schema it owns, and nothing on the database.
      await db.execute(sql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`));
      await db.execute(sql.raw(`CREATE SCHEMA "${role}" AUTHORIZATION "${role}"`));
      await mkdir(path.join(folder, 'meta'));
      await writeFile(path.join(folder, '0000_a.sql'), `CREATE TABLE "${role}"."a" ("n" int);`);
      await writeFile(
        path.join(folder, 'meta', '_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_a', breakpoints: true }],
        }),
      );
      const asRole = new URL(url ?? '');
      asRole.username = role;
      asRole.password = password;
      const options = { url: asRole.toString(), appName, migrationsFolder: folder };
      expect(await migrateApp(options)).toEqual({ applied: 1, ledgerTotal: 1 });
      expect(await migrateApp(options)).toEqual({ applied: 0, ledgerTotal: 1 });

      // The role can create no other schema, IF NOT EXISTS or not, so never one of another app's.
      const client = new pg.Client({ connectionString: asRole.toString() });
      await client.connect();
      try {
        for (const statement of [
          `CREATE SCHEMA "${role}_other"`,
          `CREATE SCHEMA IF NOT EXISTS "${role}_other"`,
        ]) {
          await expect(client.query(statement)).rejects.toThrow(/permission denied/u);
        }
      } finally {
        await client.end();
      }
    } finally {
      await db.execute(sql.raw(`drop schema if exists "${role}" cascade`));
      await db.execute(sql.raw(`drop role if exists "${role}"`));
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('reads the created table through the Drizzle table of tablesOf', async () => {
    const [tickets] = CONFORMANCE_RESOURCES;
    if (tickets === undefined) throw new Error('no fixture');
    const { db, appName } = ready();
    const someone = fakePerson({ workspaceId: crypto.randomUUID() });
    const created = await storeOf(tickets, { db, appName }).create(someone, { title: 'drizzle' });
    const table = tablesOf(tickets, appName);
    const rows = await db.select().from(table).where(eq(table['id']!, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'drizzle',
      status: 'open',
      workspace_id: someone.workspaceId,
    });
  });

  describeResourceStoreConformance(
    'storeOf conforms to the ResourceStore port',
    (resource, options) => {
      const { db, appName } = ready();
      const audit = appAuditTable(appName);
      return {
        store: storeOf(resource, {
          db,
          appName,
          now: options.now,
          ...(options.afterWrite === undefined ? {} : { afterWrite: options.afterWrite }),
          ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
        }),
        auditEvents: async () =>
          await db.select().from(audit).where(eq(audit.resource, resource.name)),
      };
    },
    { describe, it },
  );
});
