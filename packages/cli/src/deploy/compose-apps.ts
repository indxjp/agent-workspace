/**
 * The single-vm Compose overlay for `environments.production.apps` (issue #1512, ADR-0103's
 * production-apps amendment): `compose.apps.yaml`, which `aw deploy` writes beside the state's
 * `compose.yaml` and selects with `COMPOSE_FILE`. `render` never writes it: the Compose file it
 * owns is copied verbatim (ADR-0090), and v1 profiles have no apps.
 *
 * Per app there are two services. `app-<name>-role` is a one-shot `psql` on the pinned PostgreSQL
 * image that creates the app's own role and the schema it owns; `app-<name>` runs the app's
 * digest-pinned image with a `DATABASE_URL` for that role, never the platform's. Every secret is a
 * `${…}` reference to a `.env` line; no value is rendered. Pure: it reads and writes nothing.
 */
import { appSchemaName, type ProductionApp } from '@indx-workspace/contracts/project-file';
import { Document, isScalar, visit } from 'yaml';

/** The overlay's file name beside `compose.yaml`; `compose.override.yaml` is the test harness's. */
export const COMPOSE_APPS_FILE = 'compose.apps.yaml';

/** `.env`'s `COMPOSE_FILE` while the project has apps: the platform's file, then the overlay. */
export const COMPOSE_FILE_WITH_APPS = `compose.yaml:${COMPOSE_APPS_FILE}`;

/** App `i`, in name order, is published on the VM's loopback at `APP_PORT_BASE + i`. */
export const APP_PORT_BASE = 3100;

const HEADER = '# Written by aw deploy from environments.production.apps; edits are overwritten.\n';

/** One app as the overlay and the next steps see it. */
export interface ComposeApp {
  readonly name: string;
  readonly app: ProductionApp;
  /** The PostgreSQL role and schema, `app_<snake>`. */
  readonly role: string;
  /** The `.env` infix of the app's lines: `service-desk` → `SERVICE_DESK`. */
  readonly envName: string;
  /** The loopback port Caddy proxies the app's host to. */
  readonly port: number;
}

function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/** `AW_APP_<NAME>_…`'s `<NAME>`. */
export function appEnvName(name: string): string {
  return name.toUpperCase().replaceAll('-', '_');
}

/** The apps sorted by name (code unit), each with its role, `.env` infix and loopback port. */
export function composeApps(apps: Readonly<Record<string, ProductionApp>>): readonly ComposeApp[] {
  return Object.entries(apps)
    .sort(([left], [right]) => byCodeUnit(left, right))
    .map(([name, app], index) => ({
      name,
      app,
      role: appSchemaName(name),
      envName: appEnvName(name),
      port: APP_PORT_BASE + index,
    }));
}

/** The two `.env` lines `aw deploy` generates once per app; the overlay only references them. */
export function appSecretNames(envName: string): readonly [string, string] {
  return [`AW_APP_${envName}_DB_PASSWORD`, `AW_APP_${envName}_IDENTITY_SECRET`];
}

/**
 * The role script, run by `psql` from standard input so `:'APP_PASSWORD'` is interpolated (psql
 * does not interpolate `-c`). The password reaches psql through `-v` and is quoted by psql, never
 * spliced into the text. Idempotent: the role is created when absent, its password is set on every
 * run, and the schema is created and handed to the role.
 *
 * The role holds no privilege on the database itself, so it can create no schema: it owns only
 * `app_<name>`, which this script creates, and `migrateApp` runs `CREATE SCHEMA` only when the
 * schema is missing.
 *
 * It runs as Cloud SQL's database owner too, which is not a superuser (only `cloudsqlsuperuser`,
 * with CREATEROLE and CREATEDB), so it uses nothing a superuser alone may do. PostgreSQL 16+
 * refuses SUPERUSER, REPLICATION and BYPASSRLS in a non-superuser's `ALTER ROLE`, even to remove
 * them: a new role has none, so they are removed only from a role that has one, which a superuser
 * (Compose) does and Cloud SQL refuses, failing the job rather than leaving the role privileged.
 * Handing a schema to a role needs SET ROLE on it, and a non-superuser holds only ADMIN OPTION on a
 * role it created, so the owner grants itself SET without INHERIT: it never acts with the app's
 * privileges.
 *
 * `dollar` is the dollar-quote delimiter: `$$$$` in the Compose overlay, because Compose
 * interpolates `$` in the value, and `$$` where the text reaches psql as it stands (the Cloud Run
 * role job).
 */
export function appRoleSql(role: string, dollar: '$$' | '$$$$'): string {
  return [
    `DO ${dollar}`,
    'BEGIN',
    `  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN`,
    `    CREATE ROLE ${role} LOGIN;`,
    '  END IF;',
    `  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}' AND (rolsuper OR rolreplication OR rolbypassrls)) THEN`,
    `    ALTER ROLE ${role} WITH NOSUPERUSER NOREPLICATION NOBYPASSRLS;`,
    '  END IF;',
    'END',
    `${dollar};`,
    `ALTER ROLE ${role} WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD :'APP_PASSWORD';`,
    `GRANT ${role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;`,
    `CREATE SCHEMA IF NOT EXISTS ${role} AUTHORIZATION ${role};`,
    `ALTER SCHEMA ${role} OWNER TO ${role};`,
    '',
  ].join('\n');
}

const HARDENED = {
  read_only: true,
  cap_drop: ['ALL'],
  security_opt: ['no-new-privileges:true'],
} as const;

function roleService({ name, role, envName }: ComposeApp): Readonly<Record<string, unknown>> {
  const [password] = appSecretNames(envName);
  return {
    image: '${POSTGRES_IMAGE:?POSTGRES_IMAGE must be digest pinned}',
    restart: 'no',
    ...HARDENED,
    depends_on: { postgres: { condition: 'service_healthy' } },
    environment: {
      PGHOST: 'postgres',
      PGUSER: '${POSTGRES_USER:?set POSTGRES_USER in .env}',
      PGPASSWORD: '${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}',
      PGDATABASE: '${POSTGRES_DB:?set POSTGRES_DB in .env}',
      APP_PASSWORD: `\${${password}:?run aw deploy production to generate ${password} for ${name}}`,
      APP_SQL: appRoleSql(role, '$$$$'),
    },
    command: [
      'sh',
      '-c',
      `printf '%s\\n' "$$APP_SQL" | psql -X -q -v ON_ERROR_STOP=1 -v APP_PASSWORD="$$APP_PASSWORD"`,
    ],
    networks: ['control'],
  };
}

const HEALTH_PROBE =
  "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))";

function appService(
  { name, app, role, envName, port }: ComposeApp,
  platformUrl: string,
): Readonly<Record<string, unknown>> {
  const [password, identitySecret] = appSecretNames(envName);
  const generated = (line: string) =>
    `\${${line}:?run aw deploy production to generate ${line} for ${name}}`;
  return {
    image: app.image,
    restart: 'unless-stopped',
    init: true,
    ...HARDENED,
    tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=64m', '/app/.next/cache:rw,nosuid,nodev,size=128m'],
    depends_on: {
      [`app-${name}-role`]: { condition: 'service_completed_successfully' },
      web: { condition: 'service_healthy' },
    },
    environment: {
      // The app's own role: the platform's DATABASE_URL is never handed to an app.
      DATABASE_URL: `postgres://${role}:${generated(password)}@postgres:5432/\${POSTGRES_DB:?set POSTGRES_DB in .env}`,
      AW_URL: new URL(platformUrl).origin,
      AW_APP_NAME: name,
      AW_APP_MIGRATE_ON_START: '1',
      AW_APP_IDENTITY_SECRET: generated(identitySecret),
      // The operator fills these after the first boot; until then the app answers
      // `app_misconfigured` and /api/health still answers 200.
      AW_APP_API_KEY: `\${AW_APP_${envName}_API_KEY:-}`,
      AW_WORKSPACE_ID: `\${AW_APP_${envName}_WORKSPACE_ID:-}`,
      AW_APP_CONNECTOR_ID: `\${AW_APP_${envName}_CONNECTOR_ID:-}`,
      // A Next.js standalone server binds HOSTNAME, which Docker sets to the container id.
      HOSTNAME: '0.0.0.0',
      PORT: '3000',
    },
    healthcheck: {
      test: ['CMD', 'node', '-e', HEALTH_PROBE],
      interval: '10s',
      timeout: '5s',
      retries: 12,
      start_period: '30s',
    },
    ports: [`127.0.0.1:${String(port)}:3000`],
    // `control` reaches postgres; `apps-ingress` publishes the port and reaches AW_URL.
    networks: ['control', 'apps-ingress'],
  };
}

/**
 * `compose.apps.yaml` for `apps`, served beside the platform at `platformUrl`. App names are sorted
 * by code unit, and app `i` is published at `127.0.0.1:<3100 + i>`.
 */
export function renderComposeApps(
  apps: Readonly<Record<string, ProductionApp>>,
  platformUrl: string,
): string {
  const ordered = composeApps(apps);
  if (ordered.length === 0) return renderEmptyComposeApps();
  const services: Record<string, unknown> = {};
  for (const app of ordered) {
    services[`app-${app.name}-role`] = roleService(app);
    services[`app-${app.name}`] = appService(app, platformUrl);
  }
  // A non-internal bridge: Docker publishes no port for a container on internal networks only.
  const document = new Document(
    { services, networks: { 'apps-ingress': {} } },
    { aliasDuplicateObjects: false },
  );
  // `restart: no` is the boolean false to a YAML 1.1 reader; quoted, it is Compose's policy name.
  visit(document, {
    Pair: (_, pair) => {
      if (
        isScalar(pair.key) &&
        pair.key.value === 'restart' &&
        isScalar(pair.value) &&
        pair.value.value === 'no'
      ) {
        pair.value.type = 'QUOTE_SINGLE';
      }
    },
  });
  return HEADER + document.toString({ lineWidth: 0, singleQuote: true });
}

/**
 * The overlay once the project lists no app: no service. `aw deploy` never removes a container, so
 * one it started before is left running (Compose reports it as an orphan).
 */
export function renderEmptyComposeApps(): string {
  return `${HEADER}services: {}\n`;
}
