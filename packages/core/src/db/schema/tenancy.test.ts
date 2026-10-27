/**
 * Spec §25 makes tenant isolation a correctness property, not a convention. This test is the
 * mechanical half of that. It walks every table the schema exports and asserts three things:
 *
 *   1. **The table is scoped.** It is either a named, justified exemption or it carries a
 *      `workspace_id` that is NOT NULL, references `workspaces.id`, and leads an index.
 *   2. **Every reference the table makes is tenant-paired.** A foreign key from one
 *      tenant-scoped table to another must carry `workspace_id` on both sides, at the same
 *      position. A single-column `agent_id -> agents(id)` says only that the agent exists
 *      *somewhere*; the `workspace_id` copy on the referring row is then free to disagree with
 *      the referenced row's, and nothing in the schema stops it. That disagreement is a
 *      cross-tenant row, which is the exact thing §25 forbids.
 *   3. **Every reference is declared.** Every column named `*_id` — whatever its SQL type —
 *      either participates in a foreign key or is declared in {@link NON_REFERENCE_ID_COLUMNS}
 *      with its type and the reason it refers to nothing in this schema. Anything else is a
 *      hard failure naming the column. Without this, rule 2 could be satisfied by deleting the
 *      constraint; and while this rule inspected only `uuid` columns it could also be satisfied
 *      by typing the column `text`, which is the hole ADR-0027 was written about.
 *
 * The three rules above are written the ADR-0015 way round: none of them looks for a table or a
 * constraint that is wrong; each requires the thing in front of it to prove it is right, and rule
 * 3 ends in an `else` that REJECTS by name. A table added in a later wave is covered the moment it
 * is exported, without anybody remembering to update this file. Each of {@link TENANT_EXEMPT},
 * {@link NON_TABLE_MODULES}, {@link NON_REFERENCE_ID_COLUMNS}, {@link TABLE_SET_NEUTRAL} and
 * {@link ALTER_TABLE_SHAPE_ONLY} is a record whose entries carry the reason for the entry, so
 * adding one is a deliberate edit and that reason is what a reviewer is asked to accept in the
 * diff.
 *
 * This header does not claim that property of the file as a whole. Where a rule here narrows a
 * listing and does not classify what it drops, the narrowing is declared with its reason on the
 * pull request that shipped it, not asserted away in prose (ADR-0028). `idColumns` in the last
 * `describe` and the `PgTable` filter below each carry that reason in a comment at the site,
 * marked `DECLARED NARROWING`.
 *
 * It needs no database: `getTableConfig` reads the schema definition itself, and the inventory
 * assertions read `migrations/` and this directory off disk, listing both with `git ls-files`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { is, SQL } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from './index.js';

/**
 * The only tables allowed to have no `workspace_id`, each with the reason. Adding an entry
 * here is how a reviewer is asked to think about tenant isolation; the test prints the reason
 * when it reports the exempt set, so a bad reason is visible in the test output.
 */
const TENANT_EXEMPT: Readonly<Record<string, string>> = {
  workspaces: 'This table IS the tenant. A workspace_id here would be its own primary key.',
  users:
    'A user is a global identity. Spec §21 binds a person to a workspace through `memberships`, ' +
    'which is what lets one identity sit in more than one workspace; a workspace_id here would ' +
    'make that impossible and duplicate the person per workspace.',
  user_identities:
    'An OIDC (issuer, subject) binding names a global user, not a workspace membership (issue ' +
    '#118). The same binding is the same fact in every workspace the user belongs to; the tenant ' +
    'is chosen after sign-in, from `memberships`, not before.',
  storage_migration_runs:
    'A verify pass of the move off the old object naming covers every workspace at once and ' +
    'decides whether old copies may be deleted for the whole deployment (the storage design, §06). ' +
    'It holds counts only, no workspace data.',
};

/**
 * Modules in this directory that define no table, each with the reason it is here.
 *
 * This record runs the opposite way to the literal table list that used to be here: it names what
 * is NOT a table, so forgetting to update it makes a new table file fail rather than pass. Adding
 * a helper is a deliberate edit; adding a table is not. It does not decide which files the gate
 * looks at — {@link schemaModuleFiles} derives those from `git ls-files` and classifies every one.
 */
const NON_TABLE_MODULES: Readonly<Record<string, string>> = {
  'index.ts': 'The barrel. It re-exports the table modules and defines none itself.',
  'columns.ts': 'Column conventions shared by every table — primary key, timestamps, bytea.',
  'one-of.ts': 'The CHECK builder that closes a text column over a fixed set of values.',
};

// The barrel exports tables, Zod schemas, helper functions and types. Widen to `unknown` first
// so the narrowing below is a real runtime check rather than a cast the compiler already believes.
//
// DECLARED NARROWING (ADR-0028). This is a filter, not a classifier: an export `is(…, PgTable)`
// fails to recognise is dropped, and nothing here rejects it. It is left that way because the
// complement is legitimately open — the barrel exports Zod schemas, constant arrays and functions,
// and no positive rule distinguishes "not a table" from "a table this predicate misread". What
// closes the direction that matters is the equality assertion in the §27 inventory: a table the
// committed migrations create and this set does not contain fails there by name. Deleting or
// weakening that assertion to a subset check is what would make this narrowing wrong.
const exported: readonly unknown[] = Object.values(schema);
const tables = exported.filter((value): value is PgTable => is(value, PgTable));

/**
 * The column name an entry in a Drizzle index or unique-constraint column list carries, or
 * `undefined` when the entry is positively a SQL expression — a functional index, which names no
 * column at all.
 *
 * This is a classifier with an `else` that REJECTS (ADR-0027 decision 2), not a shape test whose
 * non-matches vanish. An entry it cannot place throws naming the index, because an entry silently
 * read as "no column" shortens the table's index list, and a short index list is exactly how this
 * file would stop noticing a missing tenant index.
 *
 * The column case is recognised by shape rather than by `is(value, Column)` because the entries in
 * `index.config.columns` are `ExtraConfigColumn`s, which are NOT instances of `Column` — an
 * earlier version of this file used `is(…, Column)`, silently matched nothing, and reported every
 * table as having no index at all. The expression case is recognised by `is(value, SQL)`, so
 * "expression" is asserted rather than inferred from the absence of a name.
 */
function indexEntryColumnName(entry: unknown, context: string): string | undefined {
  if (is(entry, SQL)) return undefined;
  if (typeof entry === 'object' && entry !== null) {
    const name: unknown = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  throw new Error(
    `${context}: an entry in the column list is neither a named column nor a SQL expression, ` +
      'so this gate cannot read it.',
  );
}

/**
 * Every column that leads an index or a unique constraint on this table.
 *
 * @throws if an index exists whose leading entry cannot be read as a column name. An
 * unreadable index must not be silently counted as "no index" — the whole point of this
 * module is that a missing tenant index is caught, and a check that cannot run has to fail
 * (ADR-0015).
 */
function leadingIndexedColumns(table: PgTable): string[] {
  const config = getTableConfig(table);
  const leading: string[] = [];
  for (const index of config.indexes) {
    const first = index.config.columns[0];
    if (first === undefined) {
      throw new Error(`Index ${index.config.name} on ${config.name} declares no columns.`);
    }
    const name = indexEntryColumnName(first, `Index ${index.config.name} on ${config.name}`);
    // A functional index leads on an expression, which cannot lead a tenant scan, so it
    // contributes nothing. That `undefined` is the classifier's expression bucket; an entry the
    // classifier could not place threw above rather than arriving here.
    if (name !== undefined) leading.push(name);
  }
  for (const unique of config.uniqueConstraints) {
    const first = unique.columns[0];
    if (first === undefined) {
      throw new Error(
        `Unique constraint ${unique.getName()} on ${config.name} declares no columns.`,
      );
    }
    const name = indexEntryColumnName(
      first,
      `Unique constraint ${unique.getName()} on ${config.name}`,
    );
    if (name === undefined) {
      throw new Error(
        `Unique constraint ${unique.getName()} on ${config.name} leads on a SQL expression, ` +
          'which a table constraint cannot do; this gate cannot read it.',
      );
    }
    leading.push(name);
  }
  return leading;
}

/** The column that carries tenancy. One name, written once. */
const TENANT_COLUMN = 'workspace_id';

/** The suffix that makes a column look like a reference to something. */
const REFERENCE_SUFFIX = '_id';

/**
 * A `*_id` column that refers to nothing in this schema, and therefore cannot be covered by a
 * foreign key. Each entry pins the SQL type it must have and says why.
 */
interface DeclaredNonReference {
  /** `column.getSQLType()`. Pinned so that retyping the column invalidates the declaration. */
  readonly sqlType: string;
  readonly why: string;
}

/**
 * The `*_id` columns that are NOT references into this schema.
 *
 * This is the same direction as {@link NON_TABLE_MODULES}, and it is deliberate: the gate below
 * derives its contributing set by SHAPE — every column whose name ends in `_id`, on every table
 * the barrel exports, at any SQL type — and then classifies each member into exactly one of two
 * buckets, with an `else` that REJECTS by name. Nobody has to remember to add to this record,
 * because a `*_id` column that is neither covered by a foreign key nor declared here FAILS. An
 * entry is a deliberate edit; forgetting one is not a silent pass.
 *
 * The rule used to read `column.getSQLType() === 'uuid'`. That made membership in what the gate
 * inspects a property a schema author chooses: a tenant-scoped table could carry an unpaired,
 * undeclared cross-tenant reference simply by typing its id column `text`, and the gate stayed
 * green. Measured on this branch before the change: a fabricated `attack_notes` table with
 * `workspace_id` (NOT NULL, FK to workspaces, leading an index) plus a bare
 * `agent_id: text('agent_id').notNull()` and no foreign key at all ran `Tests 60 passed (60)`.
 * The same table with `agent_id` typed `uuid` failed. `text` versus `uuid` was the whole
 * difference, which is ADR-0027's "a gate whose partition is enumerated by a literal has not
 * been partitioned" wearing a type annotation instead of a list.
 */
const NON_REFERENCE_ID_COLUMNS: Readonly<Record<string, DeclaredNonReference>> = {
  'run_usage_records.provider_response_id': {
    sqlType: 'text',
    why:
      'Names the immutable response identifier assigned by an external model provider. The ' +
      'provider owns that record, so no table in this database can be a foreign-key target.',
  },
  'audit_events.subject_id': {
    sqlType: 'text',
    why:
      "§36's audit trail records what a thing WAS. The subject of `agent-deleted` does not " +
      'exist by the time anybody reads the row, so no foreign key can be declared and none is: ' +
      'the row keeps the identifier as text alongside `subject_label`, and a CHECK holds it to ' +
      "the shape of this schema's ids. It is a dead identifier, not a live reference.",
  },
  'secrets.master_key_id': {
    sqlType: 'text',
    why:
      'Names a DEPLOYMENT master key, which lives in the deployment (an environment variable, ' +
      'a KMS key name), not in a table. There is nothing in this schema for it to reference. ' +
      'It is NOT NULL and non-blank so a row nobody can decrypt cannot be written.',
  },
  'sessions.engine_session_id': {
    sqlType: 'text',
    why:
      "The ENGINE's own resume identifier, minted and owned by the engine that ran the session " +
      '(ADR-0065) — the Claude Agent SDK today. It is an opaque token from another system, not a ' +
      'key into this one.',
  },
  'agents.created_by_run_id': {
    sqlType: 'text',
    why:
      'Names the run that made the agent, as `builder_tool_calls.run_id` does: text, with no ' +
      'foreign key. The lineage records what happened and must outlive a pruned run.',
  },
  'runtime_verifications.driver_id': {
    sqlType: 'text',
    why:
      'Names a runtime DRIVER ("e2b", "docker"), a code-defined adapter registered by the ' +
      'deployment, not a row in any table. The pass is keyed by (workspace, driver) and the ' +
      'workspace half is the foreign key.',
  },
  'oauth_tokens.family_id': {
    sqlType: 'uuid',
    why:
      'Groups the codes and tokens one authorization grant issued, so reuse of one revokes the ' +
      'rest (ADR-0134 part 3). It is minted with the first row of a grant and no other table ' +
      'holds a family, so there is nothing for it to reference.',
  },
  'files.object_id': {
    sqlType: 'uuid',
    why:
      "The identity of the stored object this row's content lives under (the storage design, " +
      '§04), minted by the storage layer when the object is written. The object is a blob in ' +
      'the object store, not a row in any table, so there is nothing for it to reference.',
  },
  'session_state_blobs.object_id': {
    sqlType: 'uuid',
    why:
      'The identity of the stored object a session-state blob lives under (the storage design, ' +
      '§04), minted by the storage layer when the object is written. The object is a blob in ' +
      'the object store, not a row in any table, so there is nothing for it to reference.',
  },
  'builder_tool_calls.run_id': {
    sqlType: 'text',
    why:
      "The ENGINE's run identifier, the key the Builder journal groups its tool calls under. The " +
      'journal is keyed by the engine run, not by a row of `runs`, so there is nothing to reference.',
  },
  'builder_tool_calls.call_id': {
    sqlType: 'text',
    why:
      "The engine's own tool-use identifier, minted by the model API for each call. It is an " +
      'opaque token from another system, not a key into this one.',
  },
  'builder_tool_calls.trace_id': {
    sqlType: 'text',
    why:
      'The trace identifier of the run, written so a journal row can be found in the trace ' +
      'store. The trace store is outside this database.',
  },
  'builder_tool_calls.model_id': {
    sqlType: 'text',
    why:
      'Names the model the Builder ran on ("claude-..."), a provider-owned identifier, not a ' +
      'row of any table here.',
  },
  'shares.subject_id': {
    sqlType: 'text',
    why:
      'A share is polymorphic across agent, session, project and skill. PostgreSQL cannot attach ' +
      'one foreign key to four tables, so subject_type identifies the table and subject_id keeps ' +
      'the selected subject key. The sharing service validates it in the workspace before insert.',
  },
};

/** `audit_events.subject_id` -> `['audit_events', 'subject_id']`. */
function splitDeclarationKey(key: string): readonly [string, string] {
  const parts = key.split('.');
  const [tableName, columnName] = parts;
  if (parts.length !== 2 || tableName === undefined || columnName === undefined) {
    throw new Error(
      `NON_REFERENCE_ID_COLUMNS key ${key} is not \`table.column\`, so this gate cannot run.`,
    );
  }
  return [tableName, columnName];
}

/** A foreign key reduced to the names this file reasons about. */
interface ForeignKeyShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly foreignColumns: readonly string[];
}

function foreignKeysOf(table: PgTable): ForeignKeyShape[] {
  const config = getTableConfig(table);
  return config.foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      name: foreignKey.getName(),
      columns: reference.columns.map((column) => column.name),
      foreignTable: getTableConfig(reference.foreignTable).name,
      foreignColumns: reference.foreignColumns.map((column) => column.name),
    };
  });
}

/**
 * Every column set this table guarantees is unique: its primary key, its unique indexes and its
 * unique constraints. A foreign key may only point at one of these, so this is what proves a
 * composite target is a real key rather than a hope that PostgreSQL will complain later.
 */
function uniqueColumnSetsOf(table: PgTable): string[][] {
  const config = getTableConfig(table);
  const sets: string[][] = [];
  // `primary` is a boolean Drizzle sets on every column, so this splits the whole column list in
  // two and no member can fail to be placed. It is a total predicate, not a shape rule.
  const primary = config.columns.filter((column) => column.primary).map((column) => column.name);
  if (primary.length > 0) sets.push(primary);
  for (const primaryKey of config.primaryKeys) {
    sets.push(primaryKey.columns.map((column) => column.name));
  }
  for (const index of config.indexes) {
    // `unique` is a boolean Drizzle sets on every index, so this is a total split of the index
    // list, not a shape rule that can fail to recognise a member. A non-unique index guarantees
    // no uniqueness and therefore is no foreign-key target.
    if (!index.config.unique) continue;
    const names = index.config.columns.map((entry) =>
      indexEntryColumnName(entry, `Unique index ${index.config.name} on ${config.name}`),
    );
    // A unique index over an expression is a real uniqueness guarantee, but not one a foreign
    // key may target — PostgreSQL requires the referenced columns themselves — so it contributes
    // no column set. An entry the classifier could not read threw above.
    if (names.every((name): name is string => name !== undefined)) sets.push(names);
  }
  for (const unique of config.uniqueConstraints) {
    sets.push(unique.columns.map((column) => column.name));
  }
  return sets;
}

function hasUniqueKeyOver(table: PgTable, columns: readonly string[]): boolean {
  const wanted = [...columns].sort().join(',');
  return uniqueColumnSetsOf(table).some((set) => [...set].sort().join(',') === wanted);
}

/** The table each exported table object is named by, so a foreign key's target can be looked up. */
const tablesByName = new Map<string, PgTable>(
  tables.map((table) => [getTableConfig(table).name, table] as const),
);

/** A table is tenant-scoped unless it is on the exemption list. There is no third state. */
function isTenantScoped(name: string): boolean {
  return !(name in TENANT_EXEMPT);
}

/**
 * `undefined` if the foreign key pairs `workspace_id` on both sides at the same position, or a
 * sentence saying why it does not.
 */
function tenantPairingFault(foreignKey: ForeignKeyShape): string | undefined {
  const at = foreignKey.columns.indexOf(TENANT_COLUMN);
  if (at === -1) {
    return `does not include ${TENANT_COLUMN} among its own columns (${foreignKey.columns.join(', ')})`;
  }
  if (foreignKey.foreignColumns[at] !== TENANT_COLUMN) {
    return (
      `pairs ${TENANT_COLUMN} against ` +
      `${foreignKey.foreignColumns[at] ?? '(nothing)'} on ${foreignKey.foreignTable}`
    );
  }
  return undefined;
}

/**
 * What a foreign key *refers to*, ignoring the tenant pairing: the target table and the
 * column-to-column mapping with the `workspace_id -> workspace_id` pair removed.
 *
 * Two constraints with the same reference identity say the same thing about the data and differ
 * only in how they say it. `agents` uses exactly that: `model_connection_id` needs
 * `ON DELETE SET NULL`, which a composite key cannot express (a composite `SET NULL` would null
 * `workspace_id` too, and `workspace_id` is `NOT NULL`), so one single-column constraint carries
 * the delete action and a second, tenant-paired constraint carries the isolation. The pairing
 * rule below is therefore asked of the reference, not of each constraint separately.
 */
function referenceIdentityOf(foreignKey: ForeignKeyShape): string {
  // The one pair this identity deliberately ignores is `workspace_id -> workspace_id`, by exact
  // string equality on both halves. Every other pair is kept, so nothing is dropped for failing
  // to match a shape.
  const pairs = foreignKey.columns
    .map((column, position) => [column, foreignKey.foreignColumns[position] ?? '?'] as const)
    .filter(([column, foreign]) => !(column === TENANT_COLUMN && foreign === TENANT_COLUMN))
    .map(([column, foreign]) => `${column}->${foreign}`)
    .sort();
  return `${foreignKey.foreignTable}|${pairs.join(',')}`;
}

/**
 * References the structural rules above cannot derive, asserted by name and by exact shape.
 *
 * The rules in this file are structural: they classify a constraint from its own columns, and
 * they catch a missing constraint only when its absence leaves a visible hole — a `*_id uuid`
 * column that no foreign key covers, or a reference to a tenant-scoped table that nothing
 * pairs. That is a real gate for most edges, and it was measured to be one: deleting
 * `sessions_agent_workspace_fk` from the schema fails 2 of the tests in this file,
 * `runs_session_workspace_fk` 1, and `agents_model_connection_workspace_fk` 1.
 *
 * `sessions_member_workspace_fk` leaves no such hole. Both of its columns are already covered
 * by other constraints — `workspace_id` by the reference to `workspaces`, `user_id` by the
 * reference to `users` — and `users` is tenant-exempt, so `sessions.user_id -> users.id` is a
 * legitimate bucket-2 reference on its own. Before this registry existed, deleting the
 * constraint outright was measured to leave this file at 25 passed (25) — no failure at all.
 * Nothing structural was missing; the authorization rule of §21/§25 simply is not derivable
 * from column shapes.
 *
 * So it is named here instead. This is a positive assertion in the ADR-0015 sense: each entry
 * states the constraint that must exist and the exact reference it must make, and the test
 * fails if it is deleted, renamed, or repointed. It says nothing about `ON DELETE` behaviour —
 * `NO ACTION` and `RESTRICT` are indistinguishable on this constraint (decision 14), so a test
 * claiming to hold that choice would be a test that cannot fail.
 */
interface RequiredReference {
  readonly table: PgTable;
  readonly name: string;
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly foreignColumns: readonly string[];
  readonly why: string;
}

const REQUIRED_REFERENCES: readonly RequiredReference[] = [
  {
    table: schema.sessions,
    name: 'sessions_member_workspace_fk',
    columns: ['workspace_id', 'user_id'],
    foreignTable: 'memberships',
    foreignColumns: ['workspace_id', 'user_id'],
    why:
      '§21/§25: the person a session belongs to must hold a membership in that workspace. ' +
      '`user_id -> users.id` only says the identity exists globally, so without this a ' +
      'workspace can be handed a session owned by someone who was never a member of it.',
  },
];

describe('database schema — references that must be named, because no structural rule implies them', () => {
  it('has at least one required reference to check', () => {
    // The registry is the whole gate. An empty one would make every assertion below pass
    // vacuously, which is the ADR-0015 failure this file exists to forbid.
    expect(REQUIRED_REFERENCES.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_REFERENCES.map((required) => [required.name, required] as const))(
    '%s is declared, with exactly the columns it must have',
    (name, required) => {
      const found = foreignKeysOf(required.table).find((foreignKey) => foreignKey.name === name);
      expect(
        found,
        `${name} is not declared on ${getTableConfig(required.table).name}. ${required.why}`,
      ).toBeDefined();
      expect(found?.columns, `${name} does not carry the columns it must`).toEqual([
        ...required.columns,
      ]);
      expect(found?.foreignTable, `${name} points at the wrong table`).toBe(required.foreignTable);
      expect(found?.foreignColumns, `${name} points at the wrong columns`).toEqual([
        ...required.foreignColumns,
      ]);
      // A composite foreign key PostgreSQL would reject is not a gate either.
      const target = tablesByName.get(required.foreignTable);
      expect(
        target,
        `${name} targets ${required.foreignTable}, which the barrel does not export`,
      ).toBeDefined();
      expect(
        target !== undefined && hasUniqueKeyOver(target, required.foreignColumns),
        `${name} targets ${required.foreignTable} (${required.foreignColumns.join(', ')}), ` +
          'which is not a unique key of that table',
      ).toBe(true);
    },
  );
});

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
const SCHEMA_DIR = dirname(fileURLToPath(import.meta.url));

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
 * A `CREATE TABLE` / `DROP TABLE` statement head and the text up to its column list or the end of
 * the statement. Both are anchored at the start of a STATEMENT (see {@link migrationStatements}),
 * not searched for anywhere in the file, because they are one branch of
 * {@link classifyStatement} rather than a scan that decides which statements participate.
 * The identifier is deliberately NOT matched here: {@link tableNamesIn} classifies what the head
 * names, so a name written in a form this file cannot read is a hard failure rather than a
 * statement that quietly contributes nothing (ADR-0027 decision 3).
 */
const CREATE_TABLE_HEAD =
  /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\b(?:\s+IF\s+NOT\s+EXISTS\b)?([^(;]*)/iu;
const DROP_TABLE_HEAD = /^DROP\s+TABLE\b(?:\s+IF\s+EXISTS\b)?([^(;]*)/iu;

/** The `ALTER TABLE [IF EXISTS] [ONLY] <name>` head, and everything after it: the action. */
const ALTER_TABLE_HEAD =
  /^ALTER\s+TABLE\b(?:\s+IF\s+EXISTS\b)?(?:\s+ONLY\b)?\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?)\s+([\s\S]+)$/iu;

/** `ALTER TABLE <old> RENAME TO <new>` — the action that renames the table itself. */
const ALTER_TABLE_RENAME_TO = /^RENAME\s+TO\s+([\s\S]+)$/iu;

/** A statement that starts `CREATE SCHEMA`, whatever follows the header. */
const CREATE_SCHEMA_HEAD = /^CREATE\s+SCHEMA\b/iu;
/** Procedural statements whose dollar-quoted bodies must be inspected, not exempted by their head. */
const CREATE_FUNCTION_HEAD = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/iu;
const DO_HEAD = /^DO\b/iu;

/**
 * A `CREATE SCHEMA` whose text ENDS with its header: `[IF NOT EXISTS]`, an optional schema name,
 * an optional `AUTHORIZATION <role>`, and nothing after them.
 *
 * PostgreSQL's `CREATE SCHEMA` takes an optional schema-element list after that header, and
 * `CREATE TABLE` is one of the element forms the list accepts, so
 * `CREATE SCHEMA "s" CREATE TABLE "t" ("c" text)` is ONE statement that creates a table. Reading
 * that list means implementing a second statement grammar with no terminators in it, which this
 * file does not do; {@link classifyStatement} refuses the statement instead, so the element list is
 * a hard failure rather than a table nothing here can see.
 */
const CREATE_SCHEMA_WITHOUT_ELEMENTS =
  /^CREATE\s+SCHEMA\b(?:\s+IF\s+NOT\s+EXISTS\b)?(?:\s+(?!AUTHORIZATION\b)(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?(?:\s+AUTHORIZATION\s+(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?\s*$/iu;

/** A double-quoted PostgreSQL identifier, which keeps its case verbatim. */
const QUOTED_IDENTIFIER = /^"([^"]+)"$/u;
/** An unquoted PostgreSQL identifier, which the server folds to lower case. */
const UNQUOTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/u;

/**
 * The table name a single `CREATE TABLE` / `DROP TABLE` operand names, quoted or not, with an
 * optional schema qualifier.
 *
 * @throws naming the text if it is not one. `CREATE TABLE x AS SELECT …`, a name this reader
 * cannot split, or an operand that is not an identifier at all all land here, and the whole
 * point of the `else` is that they stop the gate instead of shrinking its derived set.
 */
function tableIdentifier(operand: string, context: string): string {
  const trimmed = operand.trim();
  const segments = trimmed.split('.');
  const name = segments[segments.length - 1];
  if (segments.length > 2 || name === undefined) {
    throw new Error(
      `${context}: cannot read \`${trimmed}\` as a table identifier, so the set of tables the ` +
        'migrations create cannot be derived.',
    );
  }
  const quoted = QUOTED_IDENTIFIER.exec(name);
  if (quoted?.[1] !== undefined) return quoted[1];
  if (UNQUOTED_IDENTIFIER.test(name)) return name.toLowerCase();
  throw new Error(
    `${context}: \`${trimmed}\` is neither a quoted nor an unquoted table identifier, so the ` +
      'set of tables the migrations create cannot be derived.',
  );
}

/**
 * Every table one statement head names. `DROP TABLE "a", "b" CASCADE` names two; a `CREATE TABLE`
 * head names one, and this rejects it by the same rule if it does not.
 */
function tableNamesIn(head: string, context: string): string[] {
  // The drop action, when present, applies to the whole operand list rather than to a name.
  const operands = head.replace(/\s+(?:CASCADE|RESTRICT)\s*$/iu, '').split(',');
  return operands.map((operand) => tableIdentifier(operand, context));
}

/** A statement, collapsed and clipped, short enough to name in an error message. */
function excerpt(statement: string): string {
  const collapsed = statement.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}…`;
}

/**
 * Every SQL statement one committed migration file contains, comments removed.
 *
 * This is the piece that stops the migration cross-check from being a scan. The set of statements
 * comes from splitting the whole file on its top-level `;`, so EVERY statement in the file reaches
 * {@link classifyStatement} and gets a verdict; nothing is selected in by matching a keyword.
 * Splitting has to understand what a top-level `;` is, so string literals, quoted identifiers,
 * dollar-quoted blocks and both comment forms are consumed as units — and an unterminated one
 * throws rather than swallowing the rest of the file into a single unreadable statement.
 *
 * The trailing text after the last `;` is returned as a statement too: PostgreSQL accepts a final
 * statement without its terminator, and dropping it here would be exactly the silent narrowing
 * this function exists to remove.
 */
function migrationStatements(sqlText: string, context: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  const finish = (): void => {
    const trimmed = current.trim();
    if (trimmed !== '') statements.push(trimmed);
    current = '';
  };
  while (index < sqlText.length) {
    const character = sqlText[index] ?? '';
    if (sqlText.startsWith('--', index)) {
      const newline = sqlText.indexOf('\n', index);
      index = newline === -1 ? sqlText.length : newline;
      current += ' ';
      continue;
    }
    if (sqlText.startsWith('/*', index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sqlText.length && depth > 0) {
        if (sqlText.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sqlText.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth > 0) {
        throw new Error(`${context}: an unterminated /* block comment; this gate cannot read it.`);
      }
      index = cursor;
      current += ' ';
      continue;
    }
    if (character === "'" || character === '"') {
      let cursor = index + 1;
      for (;;) {
        const close = sqlText.indexOf(character, cursor);
        if (close === -1) {
          throw new Error(
            `${context}: an unterminated ${character === "'" ? 'string literal' : 'quoted identifier'} ` +
              'that starts near ' +
              `\`${excerpt(sqlText.slice(index, index + 60))}\`; this gate cannot read it.`,
          );
        }
        if (sqlText[close + 1] === character) {
          cursor = close + 2;
          continue;
        }
        cursor = close + 1;
        break;
      }
      current += sqlText.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (character === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sqlText.slice(index));
      if (tag !== null) {
        const marker = tag[0];
        const close = sqlText.indexOf(marker, index + marker.length);
        if (close === -1) {
          throw new Error(
            `${context}: an unterminated ${marker} dollar-quoted block; this gate cannot read it.`,
          );
        }
        current += sqlText.slice(index, close + marker.length);
        index = close + marker.length;
        continue;
      }
    }
    if (character === ';') {
      finish();
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  finish();
  return statements;
}

/**
 * The dollar-quoted executable body of a `CREATE FUNCTION` or `DO` statement.
 *
 * Refusing other forms is deliberate. Treating a procedural statement as table-set-neutral merely
 * because its outer head says FUNCTION/DO lets table DDL hide in the body and defeats the complete
 * migration inventory below.
 */
function proceduralBody(statement: string, context: string): string {
  const markerMatch = CREATE_FUNCTION_HEAD.test(statement)
    ? /\bAS\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/iu.exec(statement)
    : /^DO\b(?:\s+LANGUAGE\s+(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/iu.exec(
        statement,
      );
  if (markerMatch === null) {
    throw new Error(
      `${context}: \`${excerpt(statement)}\` has no dollar-quoted procedural body this gate can inspect.`,
    );
  }
  const marker = markerMatch[1];
  if (marker === undefined) {
    throw new Error(`${context}: cannot identify the procedural body's dollar-quote marker.`);
  }
  const bodyStart = markerMatch.index + markerMatch[0].length;
  const bodyEnd = statement.lastIndexOf(marker);
  if (bodyEnd < bodyStart) {
    throw new Error(`${context}: \`${excerpt(statement)}\` has an unterminated ${marker} body.`);
  }
  return statement.slice(bodyStart, bodyEnd);
}

/**
 * Remove comments, literal data, and quoted identifiers while preserving executable keywords.
 * This makes body inspection structural rather than a raw keyword scan: an exception message or
 * comment may mention `CREATE TABLE`, but an executable occurrence remains visible.
 */
function executableBodyText(body: string, context: string): string {
  let executable = '';
  let index = 0;
  while (index < body.length) {
    const character = body[index] ?? '';
    if (body.startsWith('--', index)) {
      const newline = body.indexOf('\n', index);
      index = newline === -1 ? body.length : newline;
      executable += ' ';
      continue;
    }
    if (body.startsWith('/*', index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < body.length && depth > 0) {
        if (body.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (body.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth > 0) throw new Error(`${context}: unterminated comment in procedural body.`);
      index = cursor;
      executable += ' ';
      continue;
    }
    if (character === "'") {
      let cursor = index + 1;
      for (;;) {
        const close = body.indexOf("'", cursor);
        if (close === -1) throw new Error(`${context}: unterminated string in procedural body.`);
        if (body[close + 1] === "'") {
          cursor = close + 2;
          continue;
        }
        index = close + 1;
        break;
      }
      executable += ' ';
      continue;
    }
    if (character === '$') {
      const nestedMarker = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(body.slice(index));
      if (nestedMarker !== null) {
        const marker = nestedMarker[0];
        const close = body.indexOf(marker, index + marker.length);
        if (close === -1) {
          throw new Error(`${context}: unterminated ${marker} literal in procedural body.`);
        }
        index = close + marker.length;
        executable += ' ';
        continue;
      }
    }
    if (character === '"') {
      let cursor = index + 1;
      for (;;) {
        const close = body.indexOf('"', cursor);
        if (close === -1) {
          throw new Error(`${context}: unterminated quoted identifier in procedural body.`);
        }
        if (body[close + 1] === '"') {
          cursor = close + 2;
          continue;
        }
        cursor = close + 1;
        break;
      }
      executable += ' ';
      index = cursor;
      continue;
    }
    executable += character;
    index += 1;
  }
  return executable;
}

const PROCEDURAL_TABLE_SET_DDL: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'dynamic SQL (EXECUTE)',
    // Literal contents are intentionally stripped before this check, so trying to interpret one
    // quoted command would still miss format(), concatenation, and a command read from a variable.
    // Reject the execution primitive itself: this static inventory cannot prove what it will run.
    pattern: /\bEXECUTE\b/iu,
  },
  {
    name: 'CREATE TABLE',
    pattern: /\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\b/iu,
  },
  { name: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/iu },
  {
    name: 'ALTER TABLE RENAME TO',
    pattern: /\bALTER\s+TABLE\b[^;]*?\bRENAME\s+TO\b/iu,
  },
];

function assertProceduralBodyLeavesTableSetAlone(statement: string, context: string): void {
  const executable = executableBodyText(proceduralBody(statement, context), context);
  for (const ddl of PROCEDURAL_TABLE_SET_DDL) {
    if (ddl.pattern.test(executable)) {
      throw new Error(
        `${context}: \`${excerpt(statement)}\` contains executable ${ddl.name} inside its ` +
          'procedural body, so it cannot be classified as table-set-neutral.',
      );
    }
  }
}

/**
 * The verdict {@link classifyStatement} gives one migration statement. Every statement gets one;
 * there is no fifth outcome and no way to contribute nothing without saying so.
 */
type StatementVerdict =
  | { readonly kind: 'creates-tables'; readonly names: readonly string[] }
  | { readonly kind: 'drops-tables'; readonly names: readonly string[] }
  | { readonly kind: 'renames-a-table'; readonly from: string; readonly to: string }
  | { readonly kind: 'leaves-the-table-set-alone'; readonly why: string };

/**
 * Statement forms that provably cannot change WHICH tables exist, each with the reason it cannot.
 *
 * This is a classifier's positive cases, not a list of members: a statement matching none of them
 * — and none of the table forms above — is rejected by name, so adding a form here is a deliberate
 * edit that has to state why the form is harmless to the inventory.
 *
 * `CREATE SCHEMA` is deliberately absent: whether it creates a table depends on what follows its
 * header, so it is classified by its own branch in {@link classifyStatement} rather than by a
 * pattern that would answer for every form of it at once. `CREATE EXTENSION` is absent for a
 * reason it does not share: an extension's script can itself run `CREATE TABLE`, and nothing here
 * reads an extension's contents, so no entry could state truthfully that the form creates no
 * table.
 */
const TABLE_SET_NEUTRAL: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu, why: 'creates an index, not a table' },
  { pattern: /^DROP\s+INDEX\b/iu, why: 'drops an index, not a table' },
  { pattern: /^ALTER\s+INDEX\b/iu, why: 'alters an index, not a table' },
  { pattern: /^(?:CREATE|ALTER|DROP)\s+TYPE\b/iu, why: 'a type, which is not a table' },
  { pattern: /^(?:CREATE|ALTER|DROP)\s+SEQUENCE\b/iu, why: 'a sequence, which is not a table' },
  {
    pattern: /^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/iu,
    why: 'attaches a trigger to an existing table; it creates no table',
  },
  { pattern: /^COMMENT\s+ON\b/iu, why: 'attaches a comment; it creates and drops nothing' },
  {
    pattern: /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/iu,
    why: 'changes rows, not the set of tables',
  },
];

/**
 * `ALTER TABLE` actions that change a table's SHAPE rather than the set of tables, with reasons.
 *
 * `RENAME TO` is deliberately absent — it is handled above as its own verdict, because it does
 * change the set. `SET SCHEMA` is deliberately absent too: it moves the table, and this reader
 * strips schema qualifiers, so it would be read as a no-op when it is not one.
 */
const ALTER_TABLE_SHAPE_ONLY: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^ADD\b/iu, why: 'adds a column or a constraint to a table that already exists' },
  { pattern: /^DROP\b/iu, why: 'drops a column or a constraint, not the table' },
  { pattern: /^ALTER\b/iu, why: 'alters a column of a table that already exists' },
  { pattern: /^RENAME\s+(?:COLUMN\s+)?[^\s]+\s+TO\b/iu, why: 'renames a column, not the table' },
  { pattern: /^RENAME\s+CONSTRAINT\b/iu, why: 'renames a constraint, not the table' },
  { pattern: /^VALIDATE\s+CONSTRAINT\b/iu, why: 'validates a constraint on an existing table' },
  { pattern: /^(?:ENABLE|DISABLE)\b/iu, why: 'toggles a trigger or row-level security' },
  { pattern: /^OWNER\s+TO\b/iu, why: 'changes the owner; the table keeps its name' },
  { pattern: /^CLUSTER\s+ON\b/iu, why: 'sets the clustering index' },
  {
    pattern: /^SET\s+(?:\(|WITHOUT\b|LOGGED\b|UNLOGGED\b|TABLESPACE\b)/iu,
    why: 'sets a storage property',
  },
  { pattern: /^RESET\s*\(/iu, why: 'resets a storage property' },
];

/**
 * Give one migration statement a verdict.
 *
 * @throws naming the statement if it fits none of the four verdicts. That `else` is the whole
 * point: before it existed, this file found `CREATE TABLE` and `DROP TABLE` by scanning the
 * migration text and every other statement contributed nothing in silence, so
 * `ALTER TABLE "skills" RENAME TO "abilities"` — a statement `drizzle-kit` itself emits for a
 * table rename — left the derived set naming `skills` while the deployed database held
 * `abilities`, and the cross-check below passed.
 */
function classifyStatement(statement: string, context: string): StatementVerdict {
  const created = CREATE_TABLE_HEAD.exec(statement);
  if (created?.[1] !== undefined) {
    return {
      kind: 'creates-tables',
      names: tableNamesIn(created[1], `${context}, CREATE TABLE${created[1]}`),
    };
  }
  const dropped = DROP_TABLE_HEAD.exec(statement);
  if (dropped?.[1] !== undefined) {
    return {
      kind: 'drops-tables',
      names: tableNamesIn(dropped[1], `${context}, DROP TABLE${dropped[1]}`),
    };
  }
  const altered = ALTER_TABLE_HEAD.exec(statement);
  if (altered?.[1] !== undefined && altered[2] !== undefined) {
    const subject = altered[1];
    const action = altered[2].trim();
    const renamed = ALTER_TABLE_RENAME_TO.exec(action);
    if (renamed?.[1] !== undefined) {
      return {
        kind: 'renames-a-table',
        from: tableIdentifier(subject, `${context}, ${excerpt(statement)}`),
        to: tableIdentifier(renamed[1], `${context}, ${excerpt(statement)}`),
      };
    }
    for (const { pattern, why } of ALTER_TABLE_SHAPE_ONLY) {
      if (pattern.test(action)) return { kind: 'leaves-the-table-set-alone', why };
    }
    throw new Error(
      `${context}: \`${excerpt(statement)}\` is an ALTER TABLE whose action this gate cannot ` +
        'place. It will not assume the action leaves the set of tables unchanged; add the action ' +
        'to ALTER_TABLE_SHAPE_ONLY with the reason it cannot create, drop or rename a table.',
    );
  }
  if (CREATE_SCHEMA_HEAD.test(statement)) {
    if (CREATE_SCHEMA_WITHOUT_ELEMENTS.test(statement)) {
      return {
        kind: 'leaves-the-table-set-alone',
        why: 'creates a schema and stops at its header, so the statement itself creates no table',
      };
    }
    throw new Error(
      `${context}: \`${excerpt(statement)}\` is a CREATE SCHEMA that does not end at its header, ` +
        'so this gate reads it as carrying a schema-element list. PostgreSQL lets that list ' +
        'contain CREATE TABLE, which would create a table inside a statement this reader does ' +
        'not parse. Write each element as its own statement after the CREATE SCHEMA.',
    );
  }
  if (CREATE_FUNCTION_HEAD.test(statement) || DO_HEAD.test(statement)) {
    assertProceduralBodyLeavesTableSetAlone(statement, context);
    return {
      kind: 'leaves-the-table-set-alone',
      why: 'its complete procedural body contains neither static table-set DDL nor dynamic SQL',
    };
  }
  for (const { pattern, why } of TABLE_SET_NEUTRAL) {
    if (pattern.test(statement)) return { kind: 'leaves-the-table-set-alone', why };
  }
  throw new Error(
    `${context}: \`${excerpt(statement)}\` is a statement this gate cannot classify. It will ` +
      'not assume the statement leaves the set of tables unchanged, because a table this reader ' +
      'cannot see is invisible to the migration cross-check. Either express it as a form this ' +
      'classifier reads, or add it to TABLE_SET_NEUTRAL with the reason it changes no table.',
  );
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

describe('migration table inventory — procedural body inspection', () => {
  it.each([
    {
      name: 'CREATE TABLE in a function',
      sql: `CREATE FUNCTION "public"."unsafe_create"() RETURNS void LANGUAGE plpgsql AS $body$
        BEGIN
          CREATE TABLE "hidden" ("id" uuid);
        END
      $body$`,
      expected: 'CREATE TABLE',
    },
    {
      name: 'DROP TABLE in a DO block',
      sql: `DO $body$
        BEGIN
          DROP TABLE "existing";
        END
      $body$`,
      expected: 'DROP TABLE',
    },
    {
      name: 'ALTER TABLE RENAME TO in a DO block',
      sql: `DO $body$
        BEGIN
          ALTER TABLE "before" RENAME TO "after";
        END
      $body$`,
      expected: 'ALTER TABLE RENAME TO',
    },
    {
      name: 'dynamic SQL whose literal creates a table',
      sql: `DO $body$
        BEGIN
          EXECUTE 'CREATE TABLE "hidden_dynamic" ("id" uuid)';
        END
      $body$`,
      expected: 'dynamic SQL (EXECUTE)',
    },
    {
      name: 'dynamic SQL assembled without a visible DDL literal',
      sql: `DO $body$
        DECLARE
          command text;
        BEGIN
          command := current_setting('app.migration_command');
          EXECUTE command;
        END
      $body$`,
      expected: 'dynamic SQL (EXECUTE)',
    },
  ])('rejects $name', ({ sql, expected }) => {
    expect(() => classifyStatement(sql, 'procedural-regression.sql')).toThrow(expected);
  });

  it('does not treat comments or literal error text as executable table DDL', () => {
    const verdict = classifyStatement(
      `CREATE FUNCTION "public"."safe_notice"() RETURNS trigger
       LANGUAGE plpgsql
       SET search_path = pg_catalog
       AS $body$
       BEGIN
         -- CREATE TABLE "comment_only" ("id" uuid);
         /* DROP TABLE "comment_only"; */
         RAISE EXCEPTION 'ALTER TABLE old RENAME TO new';
         PERFORM "CREATE TABLE";
         RETURN NEW;
       END
       $body$`,
      'procedural-regression.sql',
    );
    expect(verdict.kind).toBe('leaves-the-table-set-alone');
  });
});

describe('database schema — §27 table inventory, derived rather than listed', () => {
  const exportedTableNames = tables.map((table) => getTableConfig(table).name).sort();

  it('applies every migration the tree tracks, and tracks every migration it applies', () => {
    // `migratedTableNames` walks the JOURNAL. A committed `.sql` the journal does not list is a
    // migration nothing runs, and every table it creates is invisible to the cross-check below.
    // A journal entry with no committed `.sql` is the mirror image, and `readFileSync` would
    // throw on it. So the two sets are derived separately and compared.
    const migrationsDir = findMigrationsDir();
    expect(trackedMigrationTags(migrationsDir)).toEqual(
      [...migrationTagsInOrder(migrationsDir)].sort(),
    );
  });

  it('exports exactly the tables the committed migrations create', () => {
    // A table added to the schema and never generated into a migration passes typecheck, passes
    // every other assertion in this file, and fails at deploy time against a real database.
    // This is where it fails instead.
    expect(exportedTableNames).toEqual(migratedTableNames());
  });

  it('has one module per table, named after the table', () => {
    const files = new Set(schemaModuleFiles());
    const missing = exportedTableNames
      .map((name) => moduleFileFor(name))
      .filter((file) => !files.has(file));
    expect(missing, `tables whose module is missing or misnamed: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('has no module that is neither a table nor a recorded helper', () => {
    // The direction that catches the mistake a person actually makes: adding `skills.ts` and
    // forgetting the line in `index.ts`. The file exists, no table is exported for it, and it
    // is not on the helper list — so it is named here rather than silently ignored.
    const tableFiles = new Set(exportedTableNames.map((name) => moduleFileFor(name)));
    const unaccounted = schemaModuleFiles().filter(
      (file) => !tableFiles.has(file) && !(file in NON_TABLE_MODULES),
    );
    expect(
      unaccounted,
      `modules that export no table and are not recorded as helpers: ${unaccounted.join(', ')}. ` +
        'Either export the table from index.ts, or add the file to NON_TABLE_MODULES with a reason.',
    ).toEqual([]);
  });

  it('records a reason for every non-table module, and each one exists', () => {
    const files = new Set(schemaModuleFiles());
    for (const [file, reason] of Object.entries(NON_TABLE_MODULES)) {
      expect(files, `${file} is recorded as a helper but is not in ${SCHEMA_DIR}`).toContain(file);
      expect(reason.length, `${file} is recorded as a helper with no reason`).toBeGreaterThan(0);
    }
  });

  it('can actually read index definitions (this test guards the reader, not the schema)', () => {
    // Without this, a change in Drizzle's internals that made `leadingIndexedColumns` return
    // nothing would turn every tenant assertion below into a false failure — or, if the
    // assertion were ever written the other way round, into a false pass.
    expect(leadingIndexedColumns(schema.memberships)).toEqual(
      expect.arrayContaining(['workspace_id', 'user_id']),
    );
  });

  it('exempts only tables with a recorded reason', () => {
    const names = new Set(tables.map((table) => getTableConfig(table).name));
    for (const exempt of Object.keys(TENANT_EXEMPT)) {
      expect(names, `${exempt} is exempted but is not a table`).toContain(exempt);
    }
  });
});

describe('database schema — §25 tenant isolation', () => {
  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s is either exempt or fully workspace-scoped',
    (name, table) => {
      const config = getTableConfig(table);
      const workspaceColumn = config.columns.find((column) => column.name === 'workspace_id');

      if (name in TENANT_EXEMPT) {
        // An exempt table must not carry the column: half a scoping is worse than none,
        // because a query can then filter on a column nothing maintains.
        expect(
          workspaceColumn,
          `${name} is on the exemption list (${TENANT_EXEMPT[name] ?? ''}) but has a workspace_id column`,
        ).toBeUndefined();
        return;
      }

      // Not exempt: the table must prove it is tenant-scoped. Each assertion below names the
      // property it requires, so a failure says which one is missing rather than "false".
      expect(
        workspaceColumn,
        `${name} has no workspace_id and is not on the exemption list`,
      ).toBeDefined();
      expect(workspaceColumn?.notNull, `${name}.workspace_id is nullable`).toBe(true);

      // Exactly one foreign key whose whole column list is `workspace_id`: the reference to the
      // tenant root. Filtering on "contains workspace_id" would now match the tenant-paired
      // composite keys too, so this asks for the shape it means.
      //
      // The keys this narrowing drops are not unexamined: every foreign key on the table is
      // classified into a named bucket by the `§25 cross-tenant referential integrity` rule
      // below, whose `else` collects a fault. What is asserted here is the count.
      const rootReferences = foreignKeysOf(table).filter(
        (foreignKey) => foreignKey.columns.length === 1 && foreignKey.columns[0] === TENANT_COLUMN,
      );
      expect(
        rootReferences.map((foreignKey) => foreignKey.name),
        `${name}.workspace_id must have exactly one single-column foreign key, to workspaces`,
      ).toHaveLength(1);
      const rootReference = rootReferences[0];
      expect(
        rootReference?.foreignTable,
        `${name}.workspace_id does not reference workspaces`,
      ).toBe('workspaces');
      expect(
        rootReference?.foreignColumns,
        `${name}.workspace_id references the wrong column of workspaces`,
      ).toEqual(['id']);

      expect(
        leadingIndexedColumns(table),
        `${name}.workspace_id leads no index, so every tenant-scoped query is a sequential scan`,
      ).toContain('workspace_id');
    },
  );
});

/**
 * `workspaces` has no `workspace_id` column — it IS the tenant (see {@link TENANT_EXEMPT}), so a
 * reference IT makes to another tenant-scoped table (issue #129's `default_model_connection_id`)
 * necessarily pairs its own `id` against the target's `workspace_id`, never `workspace_id`
 * against `workspace_id`. That pairing is exactly as safe as the ordinary one, because for this
 * one table `id` and the tenant id are the same value by construction — it is the tenant root's
 * own primary key. These two helpers are the `workspaces`-scoped mirror of
 * {@link tenantPairingFault} and {@link referenceIdentityOf}, used only where the table under
 * test is `'workspaces'` itself; on every other table `id` is an ordinary primary key with no
 * tenant meaning, so nothing below is reached for them.
 */
function workspaceSelfPairingFault(foreignKey: ForeignKeyShape): string | undefined {
  const at = foreignKey.columns.indexOf('id');
  if (at === -1) {
    return `does not include id (workspaces' own tenant column) among its own columns (${foreignKey.columns.join(', ')})`;
  }
  if (foreignKey.foreignColumns[at] !== TENANT_COLUMN) {
    return (
      `pairs id against ${foreignKey.foreignColumns[at] ?? '(nothing)'} on ${foreignKey.foreignTable}, ` +
      `not ${TENANT_COLUMN}`
    );
  }
  return undefined;
}

function workspaceSelfReferenceIdentityOf(foreignKey: ForeignKeyShape): string {
  const pairs = foreignKey.columns
    .map((column, position) => [column, foreignKey.foreignColumns[position] ?? '?'] as const)
    .filter(([column, foreign]) => !(column === 'id' && foreign === TENANT_COLUMN))
    .map(([column, foreign]) => `${column}->${foreign}`)
    .sort();
  return `${foreignKey.foreignTable}|${pairs.join(',')}`;
}

describe('database schema — §25 cross-tenant referential integrity', () => {
  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    'every reference %s makes is either tenant-paired or provably cannot be',
    (name, table) => {
      // Each foreign key must land in exactly one accepted bucket. Anything that lands in none
      // is collected and fails the test by name — this is the explicit `else` that REJECTS,
      // rather than a filter that quietly matches nothing (ADR-0015).
      const faults: string[] = [];
      const allForeignKeys = foreignKeysOf(table);

      // The references that ARE tenant-paired, by reference identity. A constraint that is not
      // paired is acceptable only when a paired constraint says the same thing.
      //
      // This narrowing builds an ALLOWANCE set, so dropping a member can only make the rule
      // stricter, never green: a key that does not land here still has to be classified by the
      // loop below, and the loop's `else` pushes a fault.
      const pairedIdentities = new Set(
        allForeignKeys
          .filter(
            (foreignKey) =>
              isTenantScoped(foreignKey.foreignTable) &&
              tenantPairingFault(foreignKey) === undefined,
          )
          .map(referenceIdentityOf),
      );

      // The `workspaces`-scoped mirror of the set above, built only when it can be non-empty —
      // see `workspaceSelfPairingFault`'s comment for why this table alone gets one.
      const workspaceSelfPairedIdentities =
        name === 'workspaces'
          ? new Set(
              allForeignKeys
                .filter(
                  (foreignKey) =>
                    isTenantScoped(foreignKey.foreignTable) &&
                    workspaceSelfPairingFault(foreignKey) === undefined,
                )
                .map(workspaceSelfReferenceIdentityOf),
            )
          : new Set<string>();

      for (const foreignKey of allForeignKeys) {
        const isRootReference =
          foreignKey.columns.length === 1 &&
          foreignKey.columns[0] === TENANT_COLUMN &&
          foreignKey.foreignTable === 'workspaces';

        if (isRootReference) {
          // Bucket 1: the reference to the tenant root itself, checked in detail above.
          continue;
        }

        if (foreignKey.foreignTable === 'workspaces') {
          faults.push(
            `${foreignKey.name} references workspaces through (${foreignKey.columns.join(', ')}); ` +
              `the only reference to the tenant root may be the single ${TENANT_COLUMN} column`,
          );
          continue;
        }

        if (!isTenantScoped(foreignKey.foreignTable)) {
          // Bucket 2: a reference to a tenant-exempt table — a global identity. It CANNOT be
          // tenant-paired, because the target has no workspace_id to pair against, so pairing
          // is not required. It must also not pretend to: a workspace_id in this key would be
          // matched against a column that does not exist.
          if (foreignKey.columns.includes(TENANT_COLUMN)) {
            faults.push(
              `${foreignKey.name} includes ${TENANT_COLUMN} but targets ` +
                `${foreignKey.foreignTable}, which is tenant-exempt ` +
                `(${TENANT_EXEMPT[foreignKey.foreignTable] ?? ''})`,
            );
          }
          continue;
        }

        // Bucket 3: a reference from one tenant-scoped table to another. It MUST be paired —
        // by this constraint, or by a sibling constraint saying the same thing (see
        // `referenceIdentityOf`) — and its target must be a declared unique key, or PostgreSQL
        // would not accept it.
        const fault = tenantPairingFault(foreignKey);
        if (fault !== undefined) {
          if (pairedIdentities.has(referenceIdentityOf(foreignKey))) {
            // Bucket 4: unpaired, but a tenant-paired sibling constrains the same reference.
            continue;
          }
          if (
            name === 'workspaces' &&
            (workspaceSelfPairingFault(foreignKey) === undefined ||
              workspaceSelfPairedIdentities.has(workspaceSelfReferenceIdentityOf(foreignKey)))
          ) {
            // Bucket 5, `workspaces`-only: paired against this table's own `id` instead of a
            // `workspace_id` it structurally cannot have — directly, or by a self-paired sibling
            // constraint saying the same thing. See `workspaceSelfPairingFault`'s comment.
            continue;
          }
          faults.push(
            `${foreignKey.name} -> ${foreignKey.foreignTable} ${fault}, and no other constraint ` +
              `pairs the same reference. Both tables are tenant-scoped, so this lets a ${name} ` +
              `row point at a ${foreignKey.foreignTable} row in a different workspace`,
          );
          continue;
        }

        const target = tablesByName.get(foreignKey.foreignTable);
        if (target === undefined) {
          faults.push(
            `${foreignKey.name} targets ${foreignKey.foreignTable}, which the schema barrel ` +
              'does not export, so this test cannot verify its key',
          );
          continue;
        }
        if (!hasUniqueKeyOver(target, foreignKey.foreignColumns)) {
          faults.push(
            `${foreignKey.name} targets ${foreignKey.foreignTable} ` +
              `(${foreignKey.foreignColumns.join(', ')}), which is not a unique key of that ` +
              'table; PostgreSQL will reject the migration',
          );
        }
      }

      expect(faults, `${name}: ${faults.join('; ')}`).toEqual([]);
    },
  );

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    'every *_id column on %s is a foreign key or a declared non-reference',
    (name, table) => {
      // Without this, the pairing rule above could be satisfied by deleting the constraint:
      // a bare `agent_id not null` with no foreign key at all has nothing to pair, so it would
      // pass by having no references to check. Here it fails.
      //
      // The contributing set is derived by shape — every column whose name ends in `_id`, at
      // any SQL type — and every member is CLASSIFIED, not filtered. The `else` at the bottom
      // rejects by name, so a column the classifier cannot place is a failure rather than a
      // column the gate silently stopped covering (ADR-0027).
      const referenced = new Set(foreignKeysOf(table).flatMap((foreignKey) => foreignKey.columns));
      // DECLARED NARROWING (ADR-0028), and the one this file cannot convert. The subject of this
      // rule IS the `*_id` naming convention, so this line is a filter: a column named `owner` or
      // `parent` that holds a foreign identifier is dropped here and no `else` rejects it.
      // Nothing in Drizzle's metadata identifies an intended referent for a column that carries
      // no foreign key, so there is no positive rule to classify the complement with. What would
      // make this wrong is a table in a later wave holding a reference in a column without the
      // suffix; the pull request declares it, and the failure message below prints the set this
      // line derived so a reader can see what was inspected.
      const idColumns = getTableConfig(table).columns.filter((column) =>
        column.name.endsWith(REFERENCE_SUFFIX),
      );
      const derived = idColumns.map((column) => `${column.name} ${column.getSQLType()}`);
      const faults: string[] = [];

      for (const column of idColumns) {
        const key = `${name}.${column.name}`;
        const sqlType = column.getSQLType();

        if (referenced.has(column.name)) {
          // Bucket 1: a live reference, covered by a foreign key. The pairing rule above then
          // decides whether that foreign key is tenant-paired.
          if (key in NON_REFERENCE_ID_COLUMNS) {
            faults.push(
              `${key} is declared in NON_REFERENCE_ID_COLUMNS but IS covered by a foreign key; ` +
                'the declaration is dead and must be deleted',
            );
          }
          continue;
        }

        const declared = NON_REFERENCE_ID_COLUMNS[key];
        if (declared === undefined) {
          // The else that rejects. This is the whole gate.
          faults.push(
            `${key} (${sqlType}) is named like a reference, is covered by no foreign key, and ` +
              'is not declared in NON_REFERENCE_ID_COLUMNS. Either give it a foreign key, or ' +
              'declare it there with its SQL type and the reason it refers to nothing in this ' +
              'schema',
          );
          continue;
        }
        if (declared.sqlType !== sqlType) {
          faults.push(
            `${key} is declared as ${declared.sqlType} but is ${sqlType}; the declaration was ` +
              'written about a different column and must be re-taken',
          );
          continue;
        }
        if (declared.why.trim() === '') {
          faults.push(`${key} is declared a non-reference with no reason`);
          continue;
        }
        // Bucket 2: a declared non-reference, at the type it was declared at, with a reason.
      }

      expect(
        faults,
        `${name}: ${faults.join('; ')}. The *_id columns this gate derived on ${name}: ` +
          `${derived.length === 0 ? '(none)' : derived.join(', ')}`,
      ).toEqual([]);
    },
  );

  it('declares no non-reference *_id column that is stale or misnamed', () => {
    // The registry is only as good as its entries. An entry naming a column that no longer
    // exists is a declaration nothing is testing, and it would sit there excusing a name a
    // later table might reuse.
    const faults: string[] = [];
    for (const [key, declared] of Object.entries(NON_REFERENCE_ID_COLUMNS)) {
      const [tableName, columnName] = splitDeclarationKey(key);
      if (!columnName.endsWith(REFERENCE_SUFFIX)) {
        faults.push(`${key} does not end in ${REFERENCE_SUFFIX}, so this gate never inspects it`);
        continue;
      }
      const table = tablesByName.get(tableName);
      if (table === undefined) {
        faults.push(`${key} names ${tableName}, which the schema barrel does not export`);
        continue;
      }
      const column = getTableConfig(table).columns.find((each) => each.name === columnName);
      if (column === undefined) {
        faults.push(`${key} names a column ${tableName} does not have`);
        continue;
      }
      if (declared.why.trim() === '') faults.push(`${key} is declared with no reason`);
    }
    expect(
      faults,
      `${faults.join('; ')}. Declared non-references: ${Object.keys(NON_REFERENCE_ID_COLUMNS).join(', ')}`,
    ).toEqual([]);
  });

  it('can actually read foreign keys and unique keys (this test guards the readers)', () => {
    // The companion to the index-reader canary above. If a Drizzle internals change made
    // `foreignKeysOf` return nothing, every assertion in this file would pass vacuously — which
    // is precisely the failure ADR-0015 exists to forbid. These two facts are read from the
    // schema, so they break loudly instead.
    const sessionKeys = foreignKeysOf(schema.sessions).map((foreignKey) => foreignKey.name);
    expect(sessionKeys).toContain('sessions_agent_workspace_fk');
    expect(hasUniqueKeyOver(schema.agents, ['id', 'workspace_id'])).toBe(true);
    expect(hasUniqueKeyOver(schema.agents, ['id', 'name'])).toBe(false);
  });
});
