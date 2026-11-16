import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationStatements } from './tenancy-migration-sql.test-support.js';
import { classifyStatement } from './tenancy-migration-verdict.test-support.js';

/**
 * The inventory is DERIVED, three ways, and the three have to agree.
 *
 * The previous revision of this file pinned the table list as a literal array. That worked
 * while the schema was one wave old and stopped working the moment a second wave added tables:
 * the array was something a person had to remember to update, and a list nobody updated is a
 * gate that quietly stops gating — the ADR-0015 shape this whole file exists to forbid. So the
 * expected set now comes from the tree instead of from a decision somebody made once:
 *
 *   1. `migrations/` — every `CREATE TABLE` the committed migrations apply, minus every
 *      `DROP TABLE`, walked in the journal's own order, with the journal itself checked against
 *      the `.sql` files the tree tracks.
 *   2. this directory — one `.ts` file per table, named after the table (W1-DB-01 decision 1),
 *      plus a named list of the modules that define no table. The file listing comes from
 *      `git ls-files` and every tracked path in it is classified.
 *   3. the barrel — what `index.ts` actually exports, which is what `drizzle-kit` reads.
 *
 * Any one of them alone can be wrong. Requiring all three to agree catches the three mistakes
 * that are actually available: a table with no migration, a migration with no table, and a
 * table file nobody added to the barrel.
 */
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schema');

/**
 * The paths `git ls-files` reports under `directory`, relative to it, in git's own order.
 *
 * The listing comes from the TRACKED TREE rather than from `readdirSync`, which is ADR-0027
 * decision 1: what CI checks out and what a reviewer reads is the index, not one machine's
 * working directory. A build output, an editor swap file or a half-written scratch module in the
 * directory is not part of the branch and must not change what a gate derives; a file that IS
 * part of the branch cannot be hidden from the gate by leaving it out of a list.
 *
 * @throws if git cannot be run, if it reports nothing, or if its `-z` output is not
 * NUL-terminated. A gate that cannot list its own members has to fail rather than derive an
 * empty set (ADR-0015).
 */
function trackedPathsIn(directory: string): string[] {
  let stdout: string;
  try {
    stdout = execFileSync('git', ['ls-files', '-z', '--', '.'], {
      cwd: directory,
      encoding: 'utf8',
    });
  } catch (cause) {
    throw new Error(
      `\`git ls-files\` could not list ${directory}, so this gate cannot derive its members.`,
      { cause },
    );
  }
  const fields = stdout.split('\0');
  const terminator = fields.pop();
  if (terminator !== '') {
    throw new Error(
      `\`git ls-files -z\` output for ${directory} is not NUL-terminated, so this gate cannot ` +
        'trust the listing it parsed.',
    );
  }
  if (fields.length === 0) {
    throw new Error(`\`git ls-files\` reports no tracked file under ${directory}.`);
  }
  return fields;
}

/**
 * Walk up from this file to the directory holding `migrations/meta/_journal.json`.
 *
 * @throws if it is not found. A check that cannot locate what it checks must fail, not skip.
 */
function findMigrationsDir(): string {
  let cursor = SCHEMA_DIR;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(cursor, 'migrations');
    try {
      readFileSync(join(candidate, 'meta', '_journal.json'), 'utf8');
      return candidate;
    } catch {
      // Not this level. Keep walking.
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(
    `No migrations/meta/_journal.json found above ${SCHEMA_DIR}. The table inventory cannot be ` +
      'derived, so this gate cannot run.',
  );
}

/** The migration tags, in the order `drizzle-kit`'s journal says they apply. */
function migrationTagsInOrder(migrationsDir: string): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  );
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('migrations/meta/_journal.json is not an object.');
  }
  const entries: unknown = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('migrations/meta/_journal.json lists no entries.');
  }
  const parsed = entries.map((entry, position) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Journal entry ${String(position)} is not an object.`);
    }
    const { idx, tag } = entry as { idx?: unknown; tag?: unknown };
    if (typeof idx !== 'number' || !Number.isInteger(idx)) {
      throw new Error(`Journal entry ${String(position)} has no integer idx.`);
    }
    if (typeof tag !== 'string' || tag === '') {
      throw new Error(`Journal entry ${String(position)} has no tag.`);
    }
    return { idx, tag };
  });
  return parsed.sort((left, right) => left.idx - right.idx).map((entry) => entry.tag);
}

/**
 * The tables the committed migrations leave behind, applied in journal order.
 *
 * Every statement of every applied migration is classified; the four verdicts are the only
 * outcomes, and the `else` in {@link classifyStatement} refuses a statement it cannot place.
 *
 * @throws if the migrations create no table at all — an empty expected set would make the
 * comparison below pass for a schema that exports nothing.
 */
function migratedTableNames(): string[] {
  const migrationsDir = findMigrationsDir();
  const present = new Set<string>();
  let created = 0;
  for (const tag of migrationTagsInOrder(migrationsDir)) {
    const sqlText = readFileSync(join(migrationsDir, `${tag}.sql`), 'utf8');
    for (const statement of migrationStatements(sqlText, `${tag}.sql`)) {
      const verdict = classifyStatement(statement, `${tag}.sql`);
      switch (verdict.kind) {
        case 'creates-tables':
          for (const name of verdict.names) {
            present.add(name);
            created += 1;
          }
          break;
        case 'drops-tables':
          for (const name of verdict.names) present.delete(name);
          break;
        case 'renames-a-table':
          if (!present.has(verdict.from)) {
            throw new Error(
              `${tag}.sql renames \`${verdict.from}\` to \`${verdict.to}\`, but no earlier ` +
                'migration creates it, so this gate cannot say what the database holds.',
            );
          }
          present.delete(verdict.from);
          present.add(verdict.to);
          break;
        case 'leaves-the-table-set-alone':
          // Classified, and its reason is on the rule that recognised it. Nothing to apply.
          break;
      }
    }
  }
  if (created === 0) {
    throw new Error(
      `No CREATE TABLE statement was found in ${migrationsDir}. Either the migrations are ` +
        'missing or this reader no longer parses them; either way this gate cannot run.',
    );
  }
  return [...present].sort();
}

/** `0001_w2_resources.sql` — a migration `drizzle-kit` applies, named by its journal tag. */
const MIGRATION_FILE = /^([0-9]{4}_[a-z0-9_]+)\.sql$/u;

/** `meta/0001_snapshot.json` — `drizzle-kit`'s own state, not a migration. */
const SNAPSHOT_FILE = /^meta\/[0-9]{4}_snapshot\.json$/u;

/** The journal, which is what says a migration runs and in which order. */
const JOURNAL_FILE = 'meta/_journal.json';

/**
 * The tags of the `.sql` migrations the tree TRACKS under `migrations/`.
 *
 * Every tracked path there is classified into migration, snapshot or journal, and anything else
 * is a hard failure naming the file. Compared against {@link migrationTagsInOrder} by the test
 * below, this is what makes a committed `.sql` that the journal does not list — a migration
 * nothing applies, whose tables the cross-check would otherwise never see — visible.
 */
function trackedMigrationTags(migrationsDir: string): string[] {
  const tags: string[] = [];
  const unaccounted: string[] = [];
  for (const path of trackedPathsIn(migrationsDir)) {
    const migration = MIGRATION_FILE.exec(path);
    if (migration?.[1] !== undefined) {
      tags.push(migration[1]);
    } else if (path === JOURNAL_FILE || SNAPSHOT_FILE.test(path)) {
      // drizzle-kit's own bookkeeping. Neither file is a migration and neither creates a table.
    } else {
      unaccounted.push(path);
    }
  }
  if (unaccounted.length > 0) {
    throw new Error(
      `Tracked under ${migrationsDir} but neither a migration, a snapshot nor the journal: ` +
        `${unaccounted.join(', ')}. This gate cannot say whether they run, so it will not pass.`,
    );
  }
  if (tags.length === 0) {
    throw new Error(`No tracked .sql migration under ${migrationsDir}; this gate cannot run.`);
  }
  return tags.sort();
}

/** `agent_skills` -> `agent-skills.ts`, which is the convention W1-DB-01 decision 1 sets. */
function moduleFileFor(tableName: string): string {
  return `${tableName.replaceAll('_', '-')}.ts`;
}

/** A schema module: kebab-case, `.ts`, flat in this directory. W1-DB-01 decision 1's shape. */
const SCHEMA_MODULE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/u;

/** A test beside the modules. It defines no table and is not part of the inventory. */
const SCHEMA_TEST_MODULE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.test\.ts$/u;

/**
 * Every schema module this directory tracks.
 *
 * The set comes from `git ls-files` (ADR-0027 decision 1), and every tracked path is CLASSIFIED
 * as a test, a schema module, or neither — and "neither" throws naming the file (decision 2).
 * The revision this replaced was `readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.ts')
 * && !name.endsWith('.test.ts'))`: a working-tree listing narrowed by a filter with no `else`.
 * Measured on this branch before the change, a tracked `attack-helper.mts` in this directory —
 * a module that exports no table and is recorded in no list — left this file at
 * `Tests 58 passed (58)`.
 *
 * @throws if the directory tracks a path this rule cannot place, or no module at all.
 */
function schemaModuleFiles(): string[] {
  const modules: string[] = [];
  const unaccounted: string[] = [];
  for (const path of trackedPathsIn(SCHEMA_DIR)) {
    if (SCHEMA_TEST_MODULE.test(path)) {
      // A test module. It is tracked here, it is not part of the table inventory, and saying so
      // is what keeps this from being a filter.
    } else if (SCHEMA_MODULE.test(path)) {
      modules.push(path);
    } else {
      unaccounted.push(path);
    }
  }
  if (unaccounted.length > 0) {
    throw new Error(
      `Tracked in ${SCHEMA_DIR} but neither a schema module nor a test: ` +
        `${unaccounted.join(', ')}. A schema module is kebab-case and \`.ts\`, flat in this ` +
        'directory (W1-DB-01 decision 1); this gate will not silently ignore a file it cannot ' +
        'place. Modules it did derive: ' +
        `${modules.length === 0 ? '(none)' : modules.join(', ')}`,
    );
  }
  if (modules.length === 0) {
    throw new Error(`No tracked schema module found in ${SCHEMA_DIR}; this gate cannot run.`);
  }
  return modules.sort();
}
export {
  findMigrationsDir,
  trackedMigrationTags,
  migrationTagsInOrder,
  migratedTableNames,
  schemaModuleFiles,
  moduleFileFor,
  SCHEMA_DIR,
};
