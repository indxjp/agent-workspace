/**
 * The app role script (`appRoleSql`) against a real PostgreSQL, run as the two database owners it
 * meets: a superuser (the Compose overlay's `POSTGRES_USER`) and, as on Cloud SQL, an owner that is
 * not one but holds CREATEROLE and CREATEDB through a group (`cloudsqlsuperuser`). The second is the
 * Cloud Run role job, which exited 3 (psql's script error) when the script used what only a
 * superuser may. Skipped loudly without `TEST_DATABASE_URL`, which must name a superuser.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appRoleSql } from './compose-apps.ts';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[compose-apps.database.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the app role ' +
      'script did NOT run against a real database.',
  );
}

function token(): string {
  return randomBytes(6).toString('hex');
}

/** `url` with another user, password and database. */
function connectionUrl(url: string, user: string, password: string, database: string): string {
  const next = new URL(url);
  next.username = user;
  next.password = password;
  next.pathname = `/${database}`;
  return next.toString();
}

async function withClient<T>(url: string, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/**
 * Run the script as psql would with `-v APP_PASSWORD=…`: psql quotes the variable into the text.
 * The passwords here are hex, so a plain literal is the same text psql would send.
 */
function runRoleScript(url: string, role: string, password: string): Promise<void> {
  const sql = appRoleSql(role, '$$').replaceAll(":'APP_PASSWORD'", `'${password}'`);
  return withClient(url, async (client) => {
    await client.query(sql);
  });
}

interface RoleFacts {
  readonly rolsuper: boolean;
  readonly rolreplication: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolcanlogin: boolean;
}

describe.skipIf(!hasDatabase)('appRoleSql against PostgreSQL', () => {
  const superuserUrl = rawUrl ?? '';
  const suffix = token();
  const group = `cloudsql_like_${suffix}`;
  const owner = `owner_${suffix}`;
  const ownerPassword = token();
  const database = `aw_app_role_${suffix}`;
  const roles: string[] = [];
  let ownerUrl = '';
  let superuserDatabaseUrl = '';

  function appRole(): string {
    const role = `app_t${token()}`;
    roles.push(role);
    return role;
  }

  function roleFacts(role: string): Promise<RoleFacts | undefined> {
    return withClient(superuserDatabaseUrl, async (client) => {
      const result = await client.query<RoleFacts>(
        'SELECT rolsuper, rolreplication, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin ' +
          'FROM pg_catalog.pg_roles WHERE rolname = $1',
        [role],
      );
      return result.rows[0];
    });
  }

  beforeAll(async () => {
    await withClient(superuserUrl, async (client) => {
      await client.query(`CREATE ROLE ${group} NOLOGIN CREATEROLE CREATEDB`);
      await client.query(
        `CREATE ROLE ${owner} LOGIN CREATEROLE CREATEDB PASSWORD '${ownerPassword}' IN ROLE ${group}`,
      );
      await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
    });
    ownerUrl = connectionUrl(superuserUrl, owner, ownerPassword, database);
    const superuser = new URL(superuserUrl);
    superuserDatabaseUrl = connectionUrl(
      superuserUrl,
      decodeURIComponent(superuser.username),
      decodeURIComponent(superuser.password),
      database,
    );
  }, 60_000);

  afterAll(async () => {
    await withClient(superuserUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const role of roles) await client.query(`DROP ROLE IF EXISTS ${role}`);
      await client.query(`DROP ROLE IF EXISTS ${owner}`);
      await client.query(`DROP ROLE IF EXISTS ${group}`);
    });
  }, 60_000);

  it('creates the role and hands it its schema as an owner that is not a superuser, as on Cloud SQL', async () => {
    const role = appRole();
    await runRoleScript(ownerUrl, role, token());
    // Idempotent, and a second run sets the new password.
    const password = token();
    await runRoleScript(ownerUrl, role, password);

    expect(await roleFacts(role)).toEqual({
      rolsuper: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
    });
    const appUrl = connectionUrl(superuserUrl, role, password, database);
    await withClient(appUrl, async (client) => {
      const schema = await client.query<{ owner: string }>(
        'SELECT nspowner::regrole::text AS owner FROM pg_catalog.pg_namespace WHERE nspname = $1',
        [role],
      );
      expect(schema.rows).toEqual([{ owner: role }]);
      await client.query(`CREATE TABLE ${role}.notes (id integer)`);
      // The role owns its schema and nothing else: it may create no other.
      await expect(client.query(`CREATE SCHEMA other_${role}`)).rejects.toThrow(
        /permission denied for database/u,
      );
    });
    // The owner may SET ROLE to the app's role but does not inherit its privileges.
    await withClient(ownerUrl, async (client) => {
      const membership = await client.query<{ inherits: boolean; sets: boolean }>(
        "SELECT pg_has_role(current_user, $1, 'USAGE') AS inherits, " +
          "pg_has_role(current_user, $1, 'SET') AS sets",
        [role],
      );
      expect(membership.rows).toEqual([{ inherits: false, sets: true }]);
    });
  });

  it('fails as a non-superuser owner when the role already holds BYPASSRLS, rather than keep it', async () => {
    const role = appRole();
    await withClient(superuserDatabaseUrl, async (client) => {
      await client.query(`CREATE ROLE ${role} LOGIN BYPASSRLS`);
    });

    await expect(runRoleScript(ownerUrl, role, token())).rejects.toThrow(/permission denied/u);
    expect((await roleFacts(role))?.rolbypassrls).toBe(true);
  });

  it('removes SUPERUSER, REPLICATION and BYPASSRLS from an existing role as a superuser, as in Compose', async () => {
    const role = appRole();
    await withClient(superuserDatabaseUrl, async (client) => {
      await client.query(`CREATE ROLE ${role} LOGIN SUPERUSER REPLICATION BYPASSRLS CREATEDB`);
    });

    await runRoleScript(superuserDatabaseUrl, role, token());

    expect(await roleFacts(role)).toMatchObject({
      rolsuper: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcreatedb: false,
    });
  });
});
