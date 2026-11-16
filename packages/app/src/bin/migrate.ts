/**
 * `aw-app migrate` (issue #1506): apply a generated app's committed migrations to its own schema
 * `app_<name>`, for `aw dev`. `aw` may not import the app kit, so it spawns this bin from the
 * project's own install with `DATABASE_URL` in its environment, and refuses to start the app when
 * the exit code is not 0, showing what was printed on stderr.
 *
 * The connection string is read from `DATABASE_URL` only, never from the command line, so it is in
 * no process listing; no message here ever echoes it (it carries a password).
 */
import path from 'node:path';

import { z } from 'zod';

import type { AppMigrationOutcome, MigrateAppOptions } from '../db/migrate.js';
import { appSchemaName } from '../db/schema-name.js';
import { AW_APP_EXIT, type AwAppIo } from './sql.js';

/** The usage line of `aw-app migrate`. */
export const MIGRATE_USAGE = 'usage: aw-app migrate --app <name> --dir <migrations-folder>\n';

const DatabaseUrlSchema = z.url({ protocol: /^postgres(?:ql)?$/u });

/** What `aw-app migrate` runs on: its environment, its working directory and the migrator. */
export interface AwAppMigrateDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly migrateApp: (options: MigrateAppOptions) => Promise<AppMigrationOutcome>;
}

/** `--app <name>` and `--dir <folder>`, each once, or `undefined` when the line is not that. */
function migrateArguments(
  argv: readonly string[],
): { readonly appName: string; readonly dir: string } | undefined {
  const values = new Map<string, string>();
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift() ?? '';
    const match = /^--(app|dir)(?:=(.*))?$/u.exec(token);
    const key = match?.[1];
    if (key === undefined || values.has(key)) return undefined;
    const value = match?.[2] ?? rest.shift();
    if (value === undefined || value === '') return undefined;
    values.set(key, value);
  }
  const appName = values.get('app');
  const dir = values.get('dir');
  return appName === undefined || dir === undefined ? undefined : { appName, dir };
}

function refused(io: AwAppIo, message: string): number {
  io.stderr(`error: ${message}\n`);
  return AW_APP_EXIT.refused;
}

/**
 * Runs `aw-app migrate <argv>`: `migrateApp` with `DATABASE_URL`, the app's name and the migrations
 * folder (relative to the working directory). Prints one line on success; a refused name, a
 * missing or malformed `DATABASE_URL` or a failed migration goes to stderr with exit code 1, a
 * misused command line with 2.
 */
export async function runAwAppMigrate(
  argv: readonly string[],
  io: AwAppIo,
  deps: AwAppMigrateDeps,
): Promise<number> {
  const parsed = migrateArguments(argv);
  if (parsed === undefined) {
    io.stderr(MIGRATE_USAGE);
    return AW_APP_EXIT.usage;
  }
  let schema: string;
  try {
    schema = appSchemaName(parsed.appName);
  } catch (error) {
    if (error instanceof Error) return refused(io, error.message);
    throw error;
  }
  const url = deps.env['DATABASE_URL'];
  if (url === undefined || !DatabaseUrlSchema.safeParse(url).success) {
    return refused(io, 'DATABASE_URL must be set to a postgres:// connection string');
  }
  try {
    const outcome = await deps.migrateApp({
      url,
      appName: parsed.appName,
      migrationsFolder: path.resolve(deps.cwd, parsed.dir),
    });
    io.stdout(
      `migrated ${schema}: ${String(outcome.applied)} applied, ${String(outcome.ledgerTotal)} in total\n`,
    );
    return AW_APP_EXIT.ok;
  } catch (error) {
    // The migrator's messages name the schema, the journal or the drift, never the URL.
    return refused(io, error instanceof Error ? error.message : `migrating ${schema} failed`);
  }
}
