import { is, SQL } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';

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

export {
  type RequiredReference,
  foreignKeysOf,
  tablesByName,
  hasUniqueKeyOver,
  tables,
  NON_TABLE_MODULES,
  leadingIndexedColumns,
  TENANT_EXEMPT,
  TENANT_COLUMN,
  isTenantScoped,
  tenantPairingFault,
  referenceIdentityOf,
  workspaceSelfPairingFault,
  workspaceSelfReferenceIdentityOf,
  REFERENCE_SUFFIX,
  NON_REFERENCE_ID_COLUMNS,
  splitDeclarationKey,
};
