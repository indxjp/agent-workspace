/**
 * Differential conformance for the `er-core` family: the Lean table catalogue
 * (formal/AgentWorkspace/Er/Core.lean) replayed against the REAL schema, two ways.
 *
 *   1. The live Drizzle table objects the schema barrel exports (through the declared test-only
 *      escape `@agent-workspace/core/db/unscoped`), read with Drizzle's own `getTableConfig`,
 *      resolved from `@agent-workspace/core`'s own dependency so no second Drizzle is installed.
 *   2. the model's snapshot (`MODEL_SNAPSHOT`, generated from the journal), which is what `drizzle-kit` rendered from that schema
 *      and the latest entry of the migration journal. Only the snapshot renders CHECK bodies, so
 *      the closed-set values are compared there.
 *
 * Both directions: every table, column, key and check the model lists exists in the schema with
 * the same shape, and the schema has nothing the model lacks. The `oneOf` value gate replays
 * against `renderValueList`, and the UUID shape against the contracts package's `isUuid`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isUuid } from '@indx-workspace/contracts';
import * as schema from '@agent-workspace/core/db/unscoped';
import * as drizzleModule from 'drizzle-orm';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors, MODEL_SNAPSHOT, type FormalVector } from './vectors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tableVectors = loadVectors('er-core', 'tables.json');
const catalogueVectors = loadVectors('er-core', 'catalogue.json');
const oneOfVectors = loadVectors('er-core', 'one-of.json');
const uuidVectors = loadVectors('er-core', 'uuid.json');
const referenceVectors = loadVectors('er-core', 'references.json');

// ---------------------------------------------------------------------------------------------
// Narrowing helpers: everything read from Drizzle or JSON is `unknown` until checked.

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

function asStrings(value: unknown, what: string): string[] {
  return asArray(value, what).map((item, index) => asString(item, `${what}[${String(index)}]`));
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function field(value: unknown, key: string, what: string): unknown {
  return asRecord(value, what)[key];
}

function call(value: unknown, method: string, what: string, ...args: unknown[]): unknown {
  const fn = field(value, method, what);
  if (typeof fn !== 'function') throw new Error(`${what}: ${method} is not a function`);
  return Reflect.apply(fn, value, args) as unknown;
}

function hasOwnSymbol(value: unknown, key: symbol): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key) as unknown;
}

// ---------------------------------------------------------------------------------------------
// The shape both sides are reduced to.

interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
}
interface ForeignKeyShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: string;
  readonly inline: boolean;
}
interface UniqueShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly kind: 'constraint' | 'index';
  readonly partial: boolean;
}
interface TableShape {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnShape[];
  readonly foreignKeys: readonly ForeignKeyShape[];
  readonly uniques: readonly UniqueShape[];
  readonly checks: readonly string[];
}

const byName = <T extends { readonly name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------------------------
// Side 1: the live Drizzle objects.

const pgCore: unknown = pgCoreModule;
const drizzle: unknown = drizzleModule;
const PgTable = field(pgCore, 'PgTable', 'drizzle-orm/pg-core');
const TABLE_NAME = Symbol.for('drizzle:Name');
const INLINE_FOREIGN_KEYS = Symbol.for('drizzle:PgInlineForeignKeys');

function isPgTable(value: unknown): boolean {
  return call(drizzle, 'is', 'drizzle-orm', value, PgTable) === true;
}

function columnNames(columns: unknown, what: string): string[] {
  return asArray(columns, what).map((c, i) =>
    asString(field(c, 'name', `${what}[${String(i)}]`), what),
  );
}

function tableNameOf(table: unknown, what: string): string {
  return asString(hasOwnSymbol(table, TABLE_NAME), `${what}: table name`);
}

function readDrizzleTable(table: unknown): TableShape {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const name = asString(field(config, 'name', 'table config'), 'table config name');
  const inline = new Set(
    asArray(hasOwnSymbol(table, INLINE_FOREIGN_KEYS), `${name}: inline foreign keys`).map((fk) =>
      asString(call(fk, 'getName', name), name),
    ),
  );
  const columnObjects = asArray(field(config, 'columns', name), `${name}.columns`);
  const compositeKeys = asArray(field(config, 'primaryKeys', name), `${name}.primaryKeys`);
  const primaryKey =
    compositeKeys.length > 0
      ? columnNames(field(compositeKeys[0], 'columns', name), `${name}.primaryKeys`)
      : columnObjects
          .filter((c) => field(c, 'primary', name) === true)
          .map((c) => asString(field(c, 'name', name), name));
  const columns = columnObjects.map((c) => ({
    name: asString(field(c, 'name', name), `${name} column`),
    type: asString(call(c, 'getSQLType', name), `${name} column type`),
    notNull: asBoolean(field(c, 'notNull', name), `${name} column notNull`),
  }));
  const foreignKeys = asArray(field(config, 'foreignKeys', name), `${name}.foreignKeys`).map(
    (fk) => {
      const fkName = asString(call(fk, 'getName', name), `${name} fk name`);
      const reference = call(fk, 'reference', fkName);
      const onDelete = field(fk, 'onDelete', fkName);
      return {
        name: fkName,
        columns: columnNames(field(reference, 'columns', fkName), fkName),
        refTable: tableNameOf(field(reference, 'foreignTable', fkName), fkName),
        refColumns: columnNames(field(reference, 'foreignColumns', fkName), fkName),
        onDelete: onDelete === undefined ? 'no action' : asString(onDelete, `${fkName} onDelete`),
        inline: inline.has(fkName),
      };
    },
  );
  const constraints = asArray(field(config, 'uniqueConstraints', name), `${name}.unique`).map(
    (u): UniqueShape => ({
      name: asString(call(u, 'getName', name), `${name} unique name`),
      columns: columnNames(field(u, 'columns', name), `${name} unique columns`),
      kind: 'constraint',
      partial: false,
    }),
  );
  const uniqueIndexes = asArray(field(config, 'indexes', name), `${name}.indexes`)
    .map((index) => field(index, 'config', name))
    .filter((indexConfig) => field(indexConfig, 'unique', name) === true)
    .map((indexConfig): UniqueShape => ({
      name: asString(field(indexConfig, 'name', name), `${name} index name`),
      columns: columnNames(field(indexConfig, 'columns', name), `${name} index columns`),
      kind: 'index',
      partial: field(indexConfig, 'where', name) !== undefined,
    }));
  const checks = asArray(field(config, 'checks', name), `${name}.checks`).map((c) =>
    asString(field(c, 'name', name), `${name} check name`),
  );
  return {
    name,
    primaryKey,
    columns,
    foreignKeys: byName(foreignKeys),
    uniques: byName([...constraints, ...uniqueIndexes]),
    checks: [...checks].sort(),
  };
}

const drizzleTables = new Map<string, TableShape>();
const exportsByTable = new Map<string, string>();
for (const [exportName, value] of Object.entries(schema) as [string, unknown][]) {
  if (!isPgTable(value)) continue;
  const shape = readDrizzleTable(value);
  drizzleTables.set(shape.name, shape);
  exportsByTable.set(shape.name, exportName);
}

// ---------------------------------------------------------------------------------------------
// Side 2: the drizzle-kit snapshot.

const MIGRATIONS = path.join(REPO_ROOT, 'migrations');
const journal: unknown = JSON.parse(
  readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8'),
);
const journalEntries = asArray(field(journal, 'entries', 'journal'), 'journal entries');
const latestTag = asString(field(journalEntries.at(-1), 'tag', 'journal'), 'journal tag');
const snapshot: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, MODEL_SNAPSHOT), 'utf8'));

interface SnapshotTable extends TableShape {
  readonly oneOf: ReadonlyMap<string, { readonly column: string; readonly values: string[] }>;
  readonly partialNullColumns: ReadonlyMap<string, string[]>;
  readonly partialNotNullColumns: ReadonlyMap<string, string[]>;
}

const ONE_OF =
  /^(?:"[a-z_]+"\."([a-z_]+)" is null or )?"[a-z_]+"\."([a-z_]+)" in \(((?:'[^']*'(?:, )?)+)\)$/u;

function readSnapshotTable(raw: unknown): SnapshotTable {
  const name = asString(field(raw, 'name', 'snapshot table'), 'snapshot table name');
  const columnObjects = Object.values(asRecord(field(raw, 'columns', name), `${name}.columns`));
  const composite = Object.values(
    asRecord(field(raw, 'compositePrimaryKeys', name), `${name}.compositePrimaryKeys`),
  );
  const primaryKey =
    composite.length > 0
      ? asStrings(field(composite[0], 'columns', name), `${name} pk`)
      : columnObjects
          .filter((c) => field(c, 'primaryKey', name) === true)
          .map((c) => asString(field(c, 'name', name), name));
  const foreignKeys = Object.values(asRecord(field(raw, 'foreignKeys', name), name)).map((fk) => ({
    name: asString(field(fk, 'name', name), name),
    columns: asStrings(field(fk, 'columnsFrom', name), name),
    refTable: asString(field(fk, 'tableTo', name), name),
    refColumns: asStrings(field(fk, 'columnsTo', name), name),
    onDelete: asString(field(fk, 'onDelete', name), name),
    inline: false,
  }));
  const partialNullColumns = new Map<string, string[]>();
  const partialNotNullColumns = new Map<string, string[]>();
  const uniques: UniqueShape[] = [
    ...Object.values(asRecord(field(raw, 'uniqueConstraints', name), name)).map(
      (u): UniqueShape => ({
        name: asString(field(u, 'name', name), name),
        columns: asStrings(field(u, 'columns', name), name),
        kind: 'constraint',
        partial: false,
      }),
    ),
    ...Object.values(asRecord(field(raw, 'indexes', name), name))
      .filter((index) => field(index, 'isUnique', name) === true)
      .map((index): UniqueShape => {
        const indexName = asString(field(index, 'name', name), name);
        const where = field(index, 'where', indexName);
        if (typeof where === 'string') {
          const nulls = [...where.matchAll(/"[a-z_]+"\."([a-z_]+)" is null/gu)];
          const notNulls = [...where.matchAll(/"[a-z_]+"\."([a-z_]+)" is not null/gu)];
          if (nulls.length > 0)
            partialNullColumns.set(
              indexName,
              nulls.map((m) => m[1] ?? ''),
            );
          if (notNulls.length > 0) {
            partialNotNullColumns.set(
              indexName,
              notNulls.map((m) => m[1] ?? ''),
            );
          }
        }
        return {
          name: indexName,
          columns: asArray(field(index, 'columns', indexName), indexName).map((c) =>
            asString(field(c, 'expression', indexName), indexName),
          ),
          kind: 'index',
          partial: typeof where === 'string',
        };
      }),
  ];
  const oneOf = new Map<string, { column: string; values: string[] }>();
  const checks = Object.values(asRecord(field(raw, 'checkConstraints', name), name)).map((c) => {
    const checkName = asString(field(c, 'name', name), name);
    const match = ONE_OF.exec(asString(field(c, 'value', checkName), checkName));
    if (match !== null && (match[1] === undefined || match[1] === match[2])) {
      oneOf.set(checkName, {
        column: match[2] ?? '',
        values: [...(match[3] ?? '').matchAll(/'([^']*)'/gu)].map((m) => m[1] ?? ''),
      });
    }
    return checkName;
  });
  return {
    name,
    primaryKey,
    columns: columnObjects.map((c) => ({
      name: asString(field(c, 'name', name), name),
      type: asString(field(c, 'type', name), name),
      notNull: asBoolean(field(c, 'notNull', name), name),
    })),
    foreignKeys: byName(foreignKeys),
    uniques: byName(uniques),
    checks: [...checks].sort(),
    oneOf,
    partialNullColumns,
    partialNotNullColumns,
  };
}

const snapshotTables = new Map<string, SnapshotTable>(
  Object.values(asRecord(field(snapshot, 'tables', 'snapshot'), 'snapshot tables')).map((raw) => {
    const table = readSnapshotTable(raw);
    return [table.name, table] as const;
  }),
);

// ---------------------------------------------------------------------------------------------
// The model's side, from the vectors.

interface ModelForeignKey extends ForeignKeyShape {
  readonly class: string;
  readonly setNullSound: boolean;
}
interface ModelTable extends TableShape {
  readonly tenancy: string;
  readonly source: string;
  readonly tsExport: string;
  readonly foreignKeys: readonly ModelForeignKey[];
  readonly partialNullColumns: ReadonlyMap<string, string[]>;
  readonly partialNotNullColumns: ReadonlyMap<string, string[]>;
  readonly oneOf: ReadonlyMap<string, { readonly column: string; readonly values: string[] }>;
}

function readModelTable(vector: FormalVector): ModelTable {
  const e = asRecord(vector.expected, vector.id);
  const name = asString(field(vector.input, 'table', vector.id), vector.id);
  const partialNullColumns = new Map<string, string[]>();
  const partialNotNullColumns = new Map<string, string[]>();
  const oneOf = new Map<string, { column: string; values: string[] }>();
  const uniques = asArray(e['uniques'], name).map((u): UniqueShape => {
    const uniqueName = asString(field(u, 'name', name), name);
    const partial = asStrings(field(u, 'partialNullColumns', name), name);
    if (partial.length > 0) partialNullColumns.set(uniqueName, partial);
    const partialNotNull = asStrings(field(u, 'partialNotNullColumns', name), name);
    if (partialNotNull.length > 0) partialNotNullColumns.set(uniqueName, partialNotNull);
    const kind = asString(field(u, 'kind', name), name);
    if (kind !== 'constraint' && kind !== 'index') throw new Error(`${name}: unique kind ${kind}`);
    return {
      name: uniqueName,
      columns: asStrings(field(u, 'columns', name), name),
      kind,
      partial: partial.length > 0 || partialNotNull.length > 0,
    };
  });
  const checks = asArray(e['checks'], name).map((c) => {
    const checkName = asString(field(c, 'name', name), name);
    const closed = field(c, 'oneOf', checkName);
    if (closed !== null) {
      oneOf.set(checkName, {
        column: asString(field(closed, 'column', checkName), checkName),
        values: asStrings(field(closed, 'values', checkName), checkName),
      });
    }
    return checkName;
  });
  return {
    name,
    tenancy: asString(e['tenancy'], name),
    source: asString(e['source'], name),
    tsExport: asString(e['tsExport'], name),
    primaryKey: asStrings(e['primaryKey'], name),
    columns: asArray(e['columns'], name).map((c) => ({
      name: asString(field(c, 'name', name), name),
      type: asString(field(c, 'type', name), name),
      notNull: asBoolean(field(c, 'notNull', name), name),
    })),
    foreignKeys: byName(
      asArray(e['foreignKeys'], name).map((fk) => ({
        name: asString(field(fk, 'name', name), name),
        columns: asStrings(field(fk, 'columns', name), name),
        refTable: asString(field(fk, 'refTable', name), name),
        refColumns: asStrings(field(fk, 'refColumns', name), name),
        onDelete: asString(field(fk, 'onDelete', name), name),
        inline: asBoolean(field(fk, 'inline', name), name),
        class: asString(field(fk, 'class', name), name),
        setNullSound: asBoolean(field(fk, 'setNullSound', name), name),
      })),
    ),
    uniques: byName(uniques),
    checks: [...checks].sort(),
    partialNullColumns,
    partialNotNullColumns,
    oneOf,
  };
}

const modelTables = new Map<string, ModelTable>(
  tableVectors.map((v) => {
    const table = readModelTable(v);
    return [table.name, table] as const;
  }),
);

function withoutInline(fks: readonly ForeignKeyShape[]): Omit<ForeignKeyShape, 'inline'>[] {
  return fks.map(({ name, columns, refTable, refColumns, onDelete }) => ({
    name,
    columns,
    refTable,
    refColumns,
    onDelete,
  }));
}

function modelTable(name: string): ModelTable {
  const table = modelTables.get(name);
  if (table === undefined) throw new Error(`the model has no table ${name}`);
  return table;
}

// ---------------------------------------------------------------------------------------------

describe('er-core: the set of tables', () => {
  const modelNames = asStrings(
    field(catalogueVectors[0]?.expected, 'tables', 'catalogue'),
    'catalogue tables',
  );

  it('the snapshot the model transcribes is the latest migration', () => {
    expect(MODEL_SNAPSHOT).toBe(`migrations/meta/${latestTag.split('_')[0] ?? ''}_snapshot.json`);
  });

  it('the model, the Drizzle barrel and the snapshot list the same tables', () => {
    expect(new Set(modelNames).size).toBe(modelNames.length);
    expect([...modelNames].sort()).toEqual([...drizzleTables.keys()].sort());
    expect([...modelNames].sort()).toEqual([...snapshotTables.keys()].sort());
    expect([...modelTables.keys()].sort()).toEqual([...modelNames].sort());
  });
});

describe.each(tableVectors.map((v) => [v.id, v] as const))('er-core %s', (_id, vector) => {
  const model = modelTable(asString(field(vector.input, 'table', vector.id), vector.id));
  const live = drizzleTables.get(model.name);
  const snap = snapshotTables.get(model.name);

  it('exists in the Drizzle schema under the export and module the model names', () => {
    expect(live).toBeDefined();
    expect(exportsByTable.get(model.name)).toBe(model.tsExport);
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages/core/src/db/schema', model.source),
      'utf8',
    );
    expect(source).toMatch(
      new RegExp(`export const ${model.tsExport} = pgTable\\(\\s*'${model.name}'`, 'u'),
    );
  });

  it('has the same columns, primary key, foreign keys, unique keys and checks as Drizzle', () => {
    expect(live?.columns).toEqual(model.columns);
    expect(live?.primaryKey).toEqual(model.primaryKey);
    expect(live?.foreignKeys).toEqual(
      model.foreignKeys.map(({ name, columns, refTable, refColumns, onDelete, inline }) => ({
        name,
        columns,
        refTable,
        refColumns,
        onDelete,
        inline,
      })),
    );
    expect(live?.uniques).toEqual(model.uniques);
    expect(live?.checks).toEqual(model.checks);
  });

  it('has the same shape, closed-set values and partial keys as the snapshot', () => {
    expect(snap?.columns).toEqual(model.columns);
    expect(snap?.primaryKey).toEqual(model.primaryKey);
    expect(withoutInline(snap?.foreignKeys ?? [])).toEqual(withoutInline(model.foreignKeys));
    expect(snap?.uniques).toEqual(model.uniques);
    expect(snap?.checks).toEqual(model.checks);
    expect(Object.fromEntries(snap?.oneOf ?? [])).toEqual(Object.fromEntries(model.oneOf));
    expect(Object.fromEntries(snap?.partialNullColumns ?? [])).toEqual(
      Object.fromEntries(model.partialNullColumns),
    );
    expect(Object.fromEntries(snap?.partialNotNullColumns ?? [])).toEqual(
      Object.fromEntries(model.partialNotNullColumns),
    );
  });

  it('carries workspace_id exactly when the model calls it tenant-scoped', () => {
    const hasWorkspace = live?.columns.some((c) => c.name === 'workspace_id') ?? false;
    expect(hasWorkspace).toBe(model.tenancy === 'scoped');
  });

  it.each(model.foreignKeys.map((fk) => [fk.name, fk] as const))(
    '%s: the tenancy class the model proves matches the key the schema declares',
    (_name, fk) => {
      const self = model.tenancy === 'root' ? 'id' : 'workspace_id';
      const target = modelTable(fk.refTable);
      const targetTenant = target.tenancy === 'root' ? 'id' : 'workspace_id';
      const pairsAt = (key: ForeignKeyShape): boolean =>
        key.columns.some((c, i) => c === self && key.refColumns[i] === targetTenant);
      switch (fk.class) {
        case 'root-reference':
          expect(fk).toMatchObject({ columns: ['workspace_id'], refTable: 'workspaces' });
          break;
        case 'global-reference':
          expect(target.tenancy).toBe('global');
          expect(fk.columns).not.toContain('workspace_id');
          break;
        case 'tenant-paired':
          expect(target.tenancy).toBe('scoped');
          expect(pairsAt(fk)).toBe(true);
          break;
        case 'sibling-paired': {
          expect(pairsAt(fk)).toBe(false);
          const [column] = fk.columns;
          const [refColumn] = fk.refColumns;
          const sibling = model.foreignKeys.find(
            (g) =>
              g.refTable === fk.refTable &&
              pairsAt(g) &&
              g.columns.some((c, i) => c === column && g.refColumns[i] === refColumn),
          );
          expect(sibling).toBeDefined();
          break;
        }
        default:
          throw new Error(`${fk.name}: unexpected class ${fk.class}`);
      }
      const notNull = new Set(model.columns.filter((c) => c.notNull).map((c) => c.name));
      expect(fk.setNullSound).toBe(
        fk.onDelete !== 'set null' || fk.columns.every((c) => !notNull.has(c)),
      );
    },
  );
});

describe('er-core: every *_id column is a reference or a declared non-reference', () => {
  it.each(referenceVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const declared = asArray(
      field(vector.expected, 'nonReferenceIdColumns', vector.id),
      vector.id,
    ).map((d) => {
      const table = asString(field(d, 'table', vector.id), vector.id);
      const column = asString(field(d, 'column', vector.id), vector.id);
      const type = asString(field(d, 'type', vector.id), vector.id);
      return `${table}.${column} ${type}`;
    });
    const uncovered = [...drizzleTables.values()].flatMap((table) => {
      const referenced = new Set(table.foreignKeys.flatMap((fk) => fk.columns));
      return table.columns
        .filter((c) => c.name.endsWith('_id') && !referenced.has(c.name))
        .map((c) => `${table.name}.${c.name} ${c.type}`);
    });
    expect([...uncovered].sort()).toEqual([...declared].sort());
  });
});

describe('er-core: the oneOf value gate', () => {
  it.each(oneOfVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const values = asStrings(field(vector.input, 'values', vector.id), vector.id);
    const expected = field(vector.expected, 'rendered', vector.id);
    let rendered: string | null;
    try {
      rendered = schema.renderValueList(values);
    } catch {
      rendered = null;
    }
    expect(rendered).toBe(expected);
  });
});

describe('er-core: the UUID shape', () => {
  it.each(uuidVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const expected = asBoolean(field(vector.expected, 'canonical', vector.id), vector.id);
    expect(isUuid(vector.input)).toBe(expected);
  });
});
