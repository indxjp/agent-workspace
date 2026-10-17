/**
 * Differential conformance for the `er-synthesis` family (formal/AgentWorkspace/Er/{Current,
 * Target,Refinement}.lean): the whole-schema view of today's database and its refinement onto
 * the target ER model, replayed against the REAL schema.
 *
 * The TypeScript side is the live Drizzle table objects the schema barrel exports (through the
 * declared test-only escape `@agent-workspace/core/db/unscoped`), read with Drizzle's own
 * `getTableConfig` resolved from `@agent-workspace/core`'s own dependency. Every vector states a
 * fact about today's schema that a theorem of the family rests on:
 *
 *   - clusters: the five clusters partition the tables; every check is a closed set or has a
 *     meaning; every scoped table has a `NOT NULL` `workspace_id` and one root key;
 *   - keys: every foreign key's shape, and that every composite key is tenant-paired (recomputed
 *     here from the Drizzle key, not read from the vector);
 *   - owners: every owner column's nullability and its tenant-paired key;
 *   - divergence: the current side of each cell where the target differs, so this suite fails
 *     when a proposed cleanup lands and the Lean model has to follow; the ledger's target
 *     provider set is `MODEL_PROVIDERS`, the set `runs.provider` already enforces;
 *   - refusals: each cluster's one check that whole-schema consistency must enforce is declared
 *     by Drizzle on that cluster's table;
 *   - diagram and glossary: `docs/formal/concepts.md` carries the generated target ER diagram
 *     verbatim and lists every glossary term.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { PRINCIPAL_KINDS } from '@indx-workspace/contracts/team';
import * as schema from '@agent-workspace/core/db/unscoped';
import * as drizzleModule from 'drizzle-orm';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAMILY = 'er-synthesis';
const clusterVectors = loadVectors(FAMILY, 'clusters.json');
const keyVectors = loadVectors(FAMILY, 'keys.json');
const ownerVectors = loadVectors(FAMILY, 'owners.json');
const divergenceVectors = loadVectors(FAMILY, 'divergence.json');
const diagramVectors = loadVectors(FAMILY, 'diagram.json');
const refusalVectors = loadVectors(FAMILY, 'refusals.json');
const glossaryVectors = loadVectors(FAMILY, 'glossary.json');

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

function symbolField(value: unknown, key: symbol): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key) as unknown;
}

// ---------------------------------------------------------------------------------------------
// The live Drizzle schema, reduced to what the vectors speak about.

interface KeyShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: string;
}
interface TableShape {
  readonly name: string;
  readonly columns: ReadonlyMap<string, boolean>;
  readonly keys: readonly KeyShape[];
  readonly checks: readonly string[];
}

const pgCore: unknown = pgCoreModule;
const drizzle: unknown = drizzleModule;
const PgTable = field(pgCore, 'PgTable', 'drizzle-orm/pg-core');
const TABLE_NAME = Symbol.for('drizzle:Name');

function columnNames(columns: unknown, what: string): string[] {
  return asArray(columns, what).map((c, i) =>
    asString(field(c, 'name', `${what}[${String(i)}]`), what),
  );
}

function readTable(table: unknown): TableShape {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const name = asString(field(config, 'name', 'table config'), 'table config name');
  const columns = new Map<string, boolean>(
    asArray(field(config, 'columns', name), `${name}.columns`).map((c) => [
      asString(field(c, 'name', name), `${name} column`),
      asBoolean(field(c, 'notNull', name), `${name} column notNull`),
    ]),
  );
  const keys = asArray(field(config, 'foreignKeys', name), `${name}.foreignKeys`).map((fk) => {
    const keyName = asString(call(fk, 'getName', name), `${name} key name`);
    const reference = call(fk, 'reference', keyName);
    const onDelete = field(fk, 'onDelete', keyName);
    return {
      name: keyName,
      columns: columnNames(field(reference, 'columns', keyName), keyName),
      refTable: asString(
        symbolField(field(reference, 'foreignTable', keyName), TABLE_NAME),
        `${keyName} target`,
      ),
      refColumns: columnNames(field(reference, 'foreignColumns', keyName), keyName),
      onDelete: onDelete === undefined ? 'no action' : asString(onDelete, `${keyName} onDelete`),
    };
  });
  const checks = asArray(field(config, 'checks', name), `${name}.checks`).map((c) =>
    asString(field(c, 'name', name), `${name} check name`),
  );
  return { name, columns, keys, checks };
}

const tables = new Map<string, TableShape>();
for (const value of Object.values(schema) as unknown[]) {
  if (call(drizzle, 'is', 'drizzle-orm', value, PgTable) !== true) continue;
  const shape = readTable(value);
  tables.set(shape.name, shape);
}

function tableOf(name: string): TableShape {
  const table = tables.get(name);
  if (table === undefined) throw new Error(`no Drizzle table ${name}`);
  return table;
}

function keyOf(table: string, name: string): KeyShape | undefined {
  return tableOf(table).keys.find((k) => k.name === name);
}

function readKey(value: unknown, what: string): KeyShape {
  return {
    name: asString(field(value, 'name', what), `${what}.name`),
    columns: asStrings(field(value, 'columns', what), `${what}.columns`),
    refTable: asString(field(value, 'refTable', what), `${what}.refTable`),
    refColumns: asStrings(field(value, 'refColumns', what), `${what}.refColumns`),
    onDelete: asString(field(value, 'onDelete', what), `${what}.onDelete`),
  };
}

const shapeOf = (k: KeyShape): Omit<KeyShape, 'name'> => ({
  columns: k.columns,
  refTable: k.refTable,
  refColumns: k.refColumns,
  onDelete: k.onDelete,
});

/** The column that carries a row's workspace: `id` for the root, none for a global table. */
function tenantColumn(table: string): string | undefined {
  if (table === 'workspaces') return 'id';
  if (table === 'users' || table === 'user_identities') return undefined;
  return 'workspace_id';
}

/** The key compares the child's tenant column with the parent's at the same position. */
function tenantPaired(table: string, key: KeyShape): boolean {
  const child = tenantColumn(table);
  const parent = tenantColumn(key.refTable);
  if (child === undefined || parent === undefined) return false;
  return key.columns.some((c, i) => c === child && key.refColumns[i] === parent);
}

function input(value: unknown, what: string): Record<string, unknown> {
  return asRecord(value, `${what} input`);
}

function expected(value: unknown, what: string): Record<string, unknown> {
  return asRecord(value, `${what} expected`);
}

// ---------------------------------------------------------------------------------------------

describe('er-synthesis: clusters and checks', () => {
  it('the vectors name exactly the tables Drizzle exports', () => {
    const named = clusterVectors.map((v) => asString(input(v.input, v.id)['table'], v.id));
    expect([...named].sort()).toEqual([...tables.keys()].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  for (const vector of clusterVectors) {
    it(vector.id, () => {
      const table = tableOf(asString(input(vector.input, vector.id)['table'], vector.id));
      const e = expected(vector.expected, vector.id);
      const others = asArray(e['otherChecks'], vector.id).map((c) => ({
        name: asString(field(c, 'name', vector.id), vector.id),
        clusters: asStrings(field(c, 'clusters', vector.id), vector.id),
      }));
      const closed = asStrings(e['closedSets'], vector.id);
      expect([...closed, ...others.map((c) => c.name)].sort()).toEqual([...table.checks].sort());
      for (const check of others) expect(check.clusters.length).toBeGreaterThan(0);

      const tenancy = asString(e['tenancy'], vector.id);
      const hasWorkspaceId = table.columns.has('workspace_id');
      expect(tenancy === 'scoped').toBe(hasWorkspaceId);
      expect(asBoolean(e['workspaceIdNotNull'], vector.id)).toBe(
        table.columns.get('workspace_id') === true,
      );
      const rootKey = e['rootKey'];
      if (tenancy === 'scoped') {
        const key = keyOf(table.name, asString(rootKey, vector.id));
        expect(key && shapeOf(key)).toMatchObject({
          columns: ['workspace_id'],
          refTable: 'workspaces',
          refColumns: ['id'],
        });
      } else {
        expect(rootKey).toBeNull();
      }
    });
  }
});

describe('er-synthesis: every foreign key and its tenant pairing', () => {
  it('the vectors name exactly the foreign keys Drizzle declares', () => {
    const named = keyVectors.map((v) => {
      const i = input(v.input, v.id);
      return `${asString(i['table'], v.id)}/${asString(i['name'], v.id)}`;
    });
    const declared = [...tables.values()].flatMap((t) => t.keys.map((k) => `${t.name}/${k.name}`));
    expect([...named].sort()).toEqual([...declared].sort());
  });

  for (const vector of keyVectors) {
    it(vector.id, () => {
      const i = input(vector.input, vector.id);
      const table = asString(i['table'], vector.id);
      const e = expected(vector.expected, vector.id);
      const key = keyOf(table, asString(i['name'], vector.id));
      if (key === undefined) throw new Error(`${vector.id}: no such key in Drizzle`);
      const current = readKey(e['current'], `${vector.id} current`);
      expect(shapeOf(key)).toEqual(shapeOf(current));
      expect(asBoolean(e['composite'], vector.id)).toBe(key.columns.length >= 2);
      expect(asBoolean(e['tenantPaired'], vector.id)).toBe(tenantPaired(table, key));
      // every_composite_key_is_tenant_paired, recomputed from the live key.
      if (key.columns.length >= 2) expect(tenantPaired(table, key)).toBe(true);
      const target = readKey(e['target'], `${vector.id} target`);
      expect(asBoolean(e['changed'], vector.id)).toBe(
        JSON.stringify(current) !== JSON.stringify(target),
      );
    });
  }
});

describe('er-synthesis: owner columns', () => {
  for (const vector of ownerVectors) {
    it(vector.id, () => {
      const table = tableOf(asString(input(vector.input, vector.id)['table'], vector.id));
      const e = expected(vector.expected, vector.id);
      const column = asString(e['column'], vector.id);
      expect(table.columns.get(column)).toBe(asBoolean(e['notNull'], vector.id));
      const key = keyOf(table.name, asString(e['key'], vector.id));
      expect(key && shapeOf(key)).toMatchObject({
        columns: ['workspace_id', column],
        refTable: 'workspace_principals',
        refColumns: ['workspace_id', 'id'],
      });
    });
  }
});

describe('er-synthesis: the current side of every divergence cell', () => {
  for (const vector of divergenceVectors) {
    it(vector.id, () => {
      const i = input(vector.input, vector.id);
      const e = expected(vector.expected, vector.id);
      const kind = asString(i['kind'], vector.id);
      switch (kind) {
        case 'changed-key': {
          const table = asString(i['table'], vector.id);
          const key = keyOf(table, asString(i['name'], vector.id));
          const current = readKey(e['current'], vector.id);
          expect(key && shapeOf(key)).toEqual(shapeOf(current));
          const target = readKey(e['target'], vector.id);
          expect({ name: target.name, ...shapeOf(target) }).not.toEqual({
            name: current.name,
            ...shapeOf(current),
          });
          break;
        }
        case 'added-key': {
          const table = tableOf(asString(i['table'], vector.id));
          const target = readKey(e['target'], vector.id);
          expect(table.keys.map((k) => k.name)).not.toContain(target.name);
          expect(
            table.keys.some(
              (k) =>
                k.refTable === target.refTable &&
                JSON.stringify(k.columns) === JSON.stringify(target.columns),
            ),
          ).toBe(false);
          break;
        }
        case 'columns': {
          const table = tableOf(asString(i['table'], vector.id));
          for (const c of asStrings(e['dropped'], vector.id))
            expect(table.columns.has(c)).toBe(true);
          for (const c of asStrings(e['added'], vector.id))
            expect(table.columns.has(c)).toBe(false);
          break;
        }
        case 'checks': {
          const table = tableOf(asString(i['table'], vector.id));
          const dropped = asStrings(e['dropped'], vector.id);
          for (const c of dropped) expect(table.checks).toContain(c);
          for (const c of asStrings(e['added'], vector.id)) {
            if (!dropped.includes(c)) expect(table.checks).not.toContain(c);
          }
          break;
        }
        case 'table-name': {
          expect(tables.has(asString(e['current'], vector.id))).toBe(true);
          expect(tables.has(asString(e['target'], vector.id))).toBe(false);
          break;
        }
        case 'set-null': {
          const unexecutable = [...tables.values()].flatMap((t) =>
            t.keys
              .filter(
                (k) =>
                  k.onDelete === 'set null' && k.columns.some((c) => t.columns.get(c) === true),
              )
              .map((k) => `${t.name}/${k.name}`),
          );
          const listed = asArray(e['current'], vector.id).map(
            (x) =>
              `${asString(field(x, 'table', vector.id), vector.id)}/${asString(field(x, 'name', vector.id), vector.id)}`,
          );
          expect([...unexecutable].sort()).toEqual([...listed].sort());
          expect(asArray(e['target'], vector.id)).toEqual([]);
          break;
        }
        case 'value-gate': {
          const current = asStrings(e['currentValues'], vector.id);
          const target = asStrings(e['targetValues'], vector.id);
          expect(current).toEqual([...schema.workspacePrincipalKinds]);
          expect(() => schema.renderValueList(current)).toThrow();
          expect(target).toEqual([...PRINCIPAL_KINDS]);
          expect(schema.renderValueList(target)).toBe("('membership', 'api-key')");
          break;
        }
        case 'ledger-provider': {
          const runsValues = asStrings(e['runsValues'], vector.id);
          const targetValues = asStrings(e['targetValues'], vector.id);
          expect(runsValues).toEqual([...MODEL_PROVIDERS]);
          expect(targetValues).toEqual([...MODEL_PROVIDERS]);
          expect(tableOf('runs').checks).toContain('runs_provider_valid');
          expect(tableOf('run_usage_records').checks).not.toContain(
            'run_usage_records_provider_valid',
          );
          expect(() => schema.renderValueList(targetValues)).not.toThrow();
          break;
        }
        case 'target-check': {
          const table = tableOf(asString(i['table'], vector.id));
          const violations = asStrings(e['violations'], vector.id);
          expect(violations.length).toBeGreaterThan(0);
          for (const check of violations) expect(table.checks).not.toContain(check);
          break;
        }
        default:
          throw new Error(`${vector.id}: unknown divergence kind ${kind}`);
      }
    });
  }
});

describe('er-synthesis: every cluster check is part of whole-schema consistency', () => {
  it('the refusals cover the five clusters once each', () => {
    const clusters = refusalVectors.map((v) =>
      asString(input(v.input, v.id)['cluster'], `${v.id} cluster`),
    );
    const known = new Set(
      clusterVectors.map((v) => asString(expected(v.expected, v.id)['cluster'], v.id)),
    );
    expect([...clusters].sort()).toEqual([...known].sort());
  });

  for (const vector of refusalVectors) {
    it(vector.id, () => {
      const i = input(vector.input, vector.id);
      const e = expected(vector.expected, vector.id);
      const cluster = asString(i['cluster'], vector.id);
      const table = tableOf(asString(i['table'], vector.id));
      const check = asString(e['check'], vector.id);
      expect(table.checks).toContain(check);
      expect(asStrings(e['clusters'], vector.id)).toEqual([cluster]);
      const home = clusterVectors.find(
        (v) => asString(input(v.input, v.id)['table'], v.id) === table.name,
      );
      if (home === undefined) throw new Error(`${vector.id}: no cluster vector for ${table.name}`);
      expect(asString(expected(home.expected, home.id)['cluster'], home.id)).toBe(cluster);
    });
  }
});

describe('er-synthesis: the concept page', () => {
  const page = readFileSync(path.join(REPO_ROOT, 'docs/formal/concepts.md'), 'utf8');

  for (const vector of diagramVectors) {
    it(vector.id, () => {
      const mermaid = asString(expected(vector.expected, vector.id)['mermaid'], vector.id);
      expect(page).toContain('```mermaid\n' + mermaid + '```');
    });
  }

  for (const vector of glossaryVectors) {
    it(vector.id, () => {
      const term = asString(input(vector.input, vector.id)['term'], vector.id);
      // The glossary row whose first cell is the term (Prettier pads the cell with spaces).
      const rowStart = `| **${term}**`;
      const listed = page
        .split('\n')
        .some((line) => line.startsWith(rowStart) && /^ +\|/u.test(line.slice(rowStart.length)));
      expect(listed).toBe(true);
      for (const table of asStrings(expected(vector.expected, vector.id)['tables'], vector.id)) {
        expect(tables.has(table)).toBe(true);
      }
    });
  }
});
