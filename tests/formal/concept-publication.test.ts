/**
 * Differential conformance for the `concept-publication` family, package side: the Lean
 * publication concept (formal/AgentWorkspace/Concepts/Share.lean, Er/Current/Publication.lean)
 * replayed against the REAL packages.
 *
 *   - `vocabularies.json`: the contracts' `SHARE_*` arrays and the schema's `share*` arrays list
 *     exactly the model's members, in the model's order.
 *   - `tables.json`: the live Drizzle table objects `shares`, `shareViews` and `shareRunCharges`
 *     (read with Drizzle's own `getTableConfig`) have exactly the model's columns, primary key,
 *     foreign keys, unique keys and checks; each key's tenancy class is re-derived from its
 *     columns; `migrations/meta/0025_snapshot.json` has the model's closed-set values.
 *   - `checks.json`: the snapshot's SQL of each non-closed-set check is the model's.
 *   - `shares.json`: the contracts' `ShareResourceSchema` and `ShareListItemSchema` accept the
 *     resource the model renders for each share (its keys, its `url`), and refuse it once the
 *     `url` invariant is broken either way.
 *
 * The application side (`PublishShareRequestSchema`, `toShareResource`, `ShareService.resolve`)
 * is `apps/web/formal/concept-publication.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHARE_EXPIRIES,
  SHARE_MODES,
  SHARE_SUBJECT_TYPES,
  SHARE_VISIBILITIES,
  ShareListItemSchema,
  ShareResourceSchema,
} from '@indx-workspace/contracts/shares';
import {
  shareModes,
  shareRunCharges,
  shareSubjectTypes,
  shareViews,
  shareVisibilities,
  shares,
} from '@agent-workspace/core/db/unscoped';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vocabularyVectors = loadVectors('concept-publication', 'vocabularies.json');
const tableVectors = loadVectors('concept-publication', 'tables.json');
const checkVectors = loadVectors('concept-publication', 'checks.json');
const shareVectors = loadVectors('concept-publication', 'shares.json');

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

function asStrings(value: unknown, what: string): string[] {
  return asArray(value, what).map((item, index) => asString(item, `${what}[${String(index)}]`));
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
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

// ---------------------------------------------------------------------------------------------
// Vocabularies.

const VOCABULARIES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  'subject-type': [SHARE_SUBJECT_TYPES, shareSubjectTypes],
  visibility: [SHARE_VISIBILITIES, shareVisibilities],
  mode: [SHARE_MODES, shareModes],
  expiry: [SHARE_EXPIRIES],
};

describe('share vocabularies', () => {
  it('the model lists every member of each vocabulary, in order', () => {
    for (const [name, arrays] of Object.entries(VOCABULARIES)) {
      const modelMembers = vocabularyVectors
        .filter((v) => asRecord(v.input, v.id)['vocabulary'] === name)
        .filter((v) => asRecord(v.expected, v.id)['valid'] === true)
        .map((v) => asString(asRecord(v.input, v.id)['value'], v.id));
      for (const members of arrays) expect(modelMembers).toEqual([...members]);
    }
  });

  it.each(vocabularyVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const arrays = VOCABULARIES[asString(input['vocabulary'], vector.id)];
    if (arrays === undefined) throw new Error(`${vector.id}: unknown vocabulary`);
    const value = asString(input['value'], vector.id);
    for (const members of arrays) {
      expect(members.includes(value)).toBe(expected['valid']);
      expect(members.includes(value) ? members.indexOf(value) : null).toBe(expected['index']);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Tables, from the live Drizzle objects.

const pgCore: unknown = pgCoreModule;
const TABLE_NAME = Symbol.for('drizzle:Name');
const INLINE_FOREIGN_KEYS = Symbol.for('drizzle:PgInlineForeignKeys');
const DRIZZLE_TABLES: Readonly<Record<string, unknown>> = {
  shares,
  share_views: shareViews,
  share_run_charges: shareRunCharges,
};

function columnNames(columns: unknown, what: string): string[] {
  return asArray(columns, what).map((c, i) =>
    asString(field(c, 'name', `${what}[${String(i)}]`), what),
  );
}

function symbolField(value: unknown, key: symbol): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key) as unknown;
}

interface ForeignKeyShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: string;
  readonly inline: boolean;
}

function readTable(table: unknown) {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const name = asString(field(config, 'name', 'table config'), 'table name');
  const inline = new Set(
    asArray(symbolField(table, INLINE_FOREIGN_KEYS), `${name} inline keys`).map((fk) =>
      asString(call(fk, 'getName', name), name),
    ),
  );
  const columnObjects = asArray(field(config, 'columns', name), `${name}.columns`);
  const foreignKeys: ForeignKeyShape[] = asArray(field(config, 'foreignKeys', name), name).map(
    (fk) => {
      const fkName = asString(call(fk, 'getName', name), name);
      const reference = call(fk, 'reference', fkName);
      const onDelete = field(fk, 'onDelete', fkName);
      return {
        name: fkName,
        columns: columnNames(field(reference, 'columns', fkName), fkName),
        refTable: asString(
          symbolField(field(reference, 'foreignTable', fkName), TABLE_NAME),
          fkName,
        ),
        refColumns: columnNames(field(reference, 'foreignColumns', fkName), fkName),
        onDelete: onDelete === undefined ? 'no action' : asString(onDelete, fkName),
        inline: inline.has(fkName),
      };
    },
  );
  const uniques = [
    ...asArray(field(config, 'uniqueConstraints', name), name).map((u) => ({
      name: asString(call(u, 'getName', name), name),
      columns: columnNames(field(u, 'columns', name), name),
      kind: 'constraint',
    })),
    ...asArray(field(config, 'indexes', name), name)
      .map((index) => field(index, 'config', name))
      .filter((indexConfig) => field(indexConfig, 'unique', name) === true)
      .map((indexConfig) => ({
        name: asString(field(indexConfig, 'name', name), name),
        columns: columnNames(field(indexConfig, 'columns', name), name),
        kind: 'index',
      })),
  ];
  return {
    name,
    columns: columnObjects.map((c) => ({
      name: asString(field(c, 'name', name), name),
      type: asString(call(c, 'getSQLType', name), name),
      notNull: field(c, 'notNull', name) === true,
      primary: field(c, 'primary', name) === true,
    })),
    foreignKeys,
    uniques,
    checks: asArray(field(config, 'checks', name), name).map((c) =>
      asString(field(c, 'name', name), name),
    ),
  };
}

/**
 * The tenancy class of a key, re-derived from its columns: `workspace_id → workspaces.id` is the
 * root reference, a reference to `users` is global, and a key whose `workspace_id` sits at the
 * same position as its target's `workspace_id` is tenant-paired.
 */
function tenancyClass(fk: ForeignKeyShape): string {
  if (fk.refTable === 'workspaces') {
    return fk.columns.length === 1 && fk.columns[0] === 'workspace_id' && fk.refColumns[0] === 'id'
      ? 'root-reference'
      : 'unpaired';
  }
  if (fk.refTable === 'users') {
    return fk.columns.includes('workspace_id') ? 'unpaired' : 'global-reference';
  }
  const at = fk.columns.indexOf('workspace_id');
  return at >= 0 && fk.refColumns[at] === 'workspace_id' ? 'tenant-paired' : 'unpaired';
}

// ---------------------------------------------------------------------------------------------
// The drizzle-kit snapshot.

const snapshot: unknown = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'migrations/meta/0025_snapshot.json'), 'utf8'),
);

function snapshotChecks(table: string): Record<string, unknown> {
  const tables = asRecord(field(snapshot, 'tables', 'snapshot'), 'snapshot tables');
  return asRecord(
    field(tables[`public.${table}`], 'checkConstraints', table),
    `${table} checkConstraints`,
  );
}

function snapshotCheckSql(table: string, name: string): string {
  return asString(field(snapshotChecks(table)[name], 'value', name), `${table}.${name}`);
}

describe('cluster tables', () => {
  it.each(tableVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const tableName = asString(input['table'], vector.id);
    const live = readTable(DRIZZLE_TABLES[tableName]);
    expect(live.name).toBe(tableName);

    const columns = asArray(expected['columns'], vector.id).map((c) => ({
      name: asString(field(c, 'name', vector.id), vector.id),
      type: asString(field(c, 'type', vector.id), vector.id),
      notNull: field(c, 'notNull', vector.id) === true,
    }));
    expect(live.columns.map(({ name, type, notNull }) => ({ name, type, notNull }))).toEqual(
      columns,
    );
    expect(live.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(
      asStrings(expected['primaryKey'], vector.id),
    );

    const modelKeys = asArray(expected['foreignKeys'], vector.id).map((fk) =>
      asRecord(fk, vector.id),
    );
    const liveKeys = [...live.foreignKeys].sort((a, b) => a.name.localeCompare(b.name));
    expect(liveKeys.map((fk) => fk.name)).toEqual(
      modelKeys.map((fk) => asString(fk['name'], vector.id)).sort((a, b) => a.localeCompare(b)),
    );
    for (const model of modelKeys) {
      const fk = live.foreignKeys.find((k) => k.name === model['name']);
      if (fk === undefined) throw new Error(`${vector.id}: missing ${String(model['name'])}`);
      expect(fk.columns).toEqual(asStrings(model['columns'], fk.name));
      expect(fk.refTable).toBe(model['refTable']);
      expect(fk.refColumns).toEqual(asStrings(model['refColumns'], fk.name));
      expect(fk.onDelete).toBe(model['onDelete']);
      expect(fk.inline).toBe(model['inline']);
      expect(tenancyClass(fk)).toBe(model['class']);
    }

    const modelUniques = asArray(expected['uniques'], vector.id).map((u) => ({
      name: asString(field(u, 'name', vector.id), vector.id),
      columns: asStrings(field(u, 'columns', vector.id), vector.id),
      kind: asString(field(u, 'kind', vector.id), vector.id),
    }));
    expect([...live.uniques].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...modelUniques].sort((a, b) => a.name.localeCompare(b.name)),
    );

    const modelChecks = asArray(expected['checks'], vector.id).map((c) => asRecord(c, vector.id));
    expect([...live.checks].sort()).toEqual(
      modelChecks.map((c) => asString(c['name'], vector.id)).sort(),
    );
    const snapshotNames = Object.keys(snapshotChecks(tableName)).sort();
    expect(snapshotNames).toEqual(modelChecks.map((c) => asString(c['name'], vector.id)).sort());
    for (const check of modelChecks) {
      const name = asString(check['name'], vector.id);
      const sql = snapshotCheckSql(tableName, name);
      if (check['kind'] === 'one-of') {
        const column = asString(check['column'], name);
        const values = asStrings(check['values'], name)
          .map((v) => `'${v}'`)
          .join(', ');
        expect(sql).toMatch(new RegExp(`"${column}" in \\(${values}\\)$`, 'u'));
      } else {
        expect(sql).toBe(check['sql']);
      }
    }
  });
});

describe('refined checks', () => {
  it.each(checkVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    expect(
      snapshotCheckSql(asString(input['table'], vector.id), asString(input['name'], vector.id)),
    ).toBe(expected['sql']);
    expect(asArray(expected['cases'], vector.id).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The wire resource.

function iso(value: unknown, what: string): string | null {
  return value === null ? null : new Date(asNumber(value, what)).toISOString();
}

/** The resource the model renders for a share: its keys, filled from the share, and its url. */
function modelResource(
  share: Record<string, unknown>,
  keys: readonly string[],
  url: unknown,
  what: string,
): Record<string, unknown> {
  const value = (key: string): unknown => {
    switch (key) {
      case 'expiresAt':
      case 'revokedAt':
      case 'suspendedAt':
      case 'createdAt':
        return iso(share[key], `${what} ${key}`);
      case 'url':
        return url;
      case 'viewCount':
        return 3;
      default:
        return share[key];
    }
  };
  return Object.fromEntries(keys.map((key) => [key, value(key)]));
}

describe('the wire resource the model renders', () => {
  it.each(shareVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const share = asRecord(input['share'], `${vector.id} share`);
    const keys = asStrings(expected['keys'], `${vector.id} keys`);
    const listKeys = asStrings(expected['listKeys'], `${vector.id} listKeys`);
    const resource = modelResource(share, keys, expected['url'], vector.id);
    const item = modelResource(share, listKeys, expected['url'], vector.id);

    expect(ShareResourceSchema.safeParse(resource).success).toBe(true);
    expect(ShareListItemSchema.safeParse(item).success).toBe(true);
    expect(ShareResourceSchema.safeParse(item).success).toBe(false);

    const broken =
      expected['url'] === null
        ? { ...resource, url: `/p/${asString(share['token'], vector.id)}` }
        : Object.fromEntries(Object.entries(resource).filter(([key]) => key !== 'url'));
    expect(ShareResourceSchema.safeParse(broken).success).toBe(false);
  });
});
