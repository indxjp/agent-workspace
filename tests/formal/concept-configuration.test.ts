/**
 * Differential conformance for the `concept-configuration` family (model connections, runtime
 * profiles, secrets): the Lean model in formal/AgentWorkspace/{Concepts,Er/Current}/ replayed
 * against the REAL packages, through their exports.
 *
 *   1. The three tables and every foreign key that touches them, against the live Drizzle table
 *      objects (through the declared test-only escape `@agent-workspace/core/db/unscoped`, read with
 *      Drizzle's own `getTableConfig`). Tenancy classes and delete behaviour are re-derived here from
 *      the Drizzle keys and compared with the model's.
 *   2. The refined checks, against the CHECK bodies `drizzle-kit` recorded in
 *      the model's snapshot (`MODEL_SNAPSHOT`).
 *   3. The closed sets, against the schema arrays, the contract arrays and `renderValueList`.
 *   4. The provider config rule table, the secret name shape, the wire resources (field sets, and
 *      the refusal of every credential-bearing field by the `.strict()` schemas), and the numbers the
 *      contract accepts, against `@indx-workspace/contracts` and `@agent-workspace/core`.
 *
 * The server-side parsers and stores (`apps/web/server/{models,secrets,runtimes}`) are replayed by
 * `apps/web/formal/concept-configuration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CreateRuntimeProfileInput,
  runtimeDriverIds,
  UpdateRuntimeProfileInput,
} from '@agent-workspace/run-protocol';
import * as schema from '@agent-workspace/core/db/unscoped';
import {
  MODEL_CONNECTION_CONFIG_FIELDS,
  MODEL_PROVIDER_CONFIG_RULES,
  ModelConnectionResourceSchema,
} from '@indx-workspace/contracts/models';
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';
import {
  RUNTIME_DRIVERS,
  RUNTIME_FILESYSTEM_MODES,
  RUNTIME_NETWORK_POLICIES,
  RuntimeConnectionResourceSchema,
  RuntimeProfileResourceSchema,
} from '@indx-workspace/contracts/runtimes';
import { SECRET_NAME_PATTERN, SecretResourceSchema } from '@indx-workspace/contracts/secrets';
import * as drizzleModule from 'drizzle-orm';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors, MODEL_SNAPSHOT } from './vectors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAMILY = 'concept-configuration';

// ---------------------------------------------------------------------------------------------
// Narrowing helpers.

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

function ownSymbol(value: unknown, key: symbol): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key) as unknown;
}

// ---------------------------------------------------------------------------------------------
// The live Drizzle schema.

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
}
interface ForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: string;
}
interface Table {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly Column[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly uniques: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly checks: readonly string[];
}

const pgCore: unknown = pgCoreModule;
const drizzle: unknown = drizzleModule;
const PgTable = field(pgCore, 'PgTable', 'drizzle-orm/pg-core');
const TABLE_NAME = Symbol.for('drizzle:Name');

function names(columns: unknown, what: string): string[] {
  return asArray(columns, what).map((c) => asString(field(c, 'name', what), what));
}

function readTable(table: unknown): Table {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const name = asString(field(config, 'name', 'table config'), 'table name');
  const columnObjects = asArray(field(config, 'columns', name), `${name}.columns`);
  const composite = asArray(field(config, 'primaryKeys', name), `${name}.primaryKeys`);
  const indexes = asArray(field(config, 'indexes', name), `${name}.indexes`)
    .map((index) => field(index, 'config', name))
    .filter((c) => field(c, 'unique', name) === true);
  return {
    name,
    primaryKey:
      composite.length > 0
        ? names(field(composite[0], 'columns', name), name)
        : columnObjects
            .filter((c) => field(c, 'primary', name) === true)
            .map((c) => asString(field(c, 'name', name), name)),
    columns: columnObjects.map((c) => ({
      name: asString(field(c, 'name', name), name),
      type: asString(call(c, 'getSQLType', name), name),
      notNull: asBoolean(field(c, 'notNull', name), name),
    })),
    foreignKeys: asArray(field(config, 'foreignKeys', name), name).map((fk) => {
      const fkName = asString(call(fk, 'getName', name), name);
      const reference = call(fk, 'reference', fkName);
      const onDelete = field(fk, 'onDelete', fkName);
      return {
        name: fkName,
        columns: names(field(reference, 'columns', fkName), fkName),
        refTable: asString(ownSymbol(field(reference, 'foreignTable', fkName), TABLE_NAME), fkName),
        refColumns: names(field(reference, 'foreignColumns', fkName), fkName),
        onDelete: onDelete === undefined ? 'no action' : asString(onDelete, fkName),
      };
    }),
    uniques: [
      ...asArray(field(config, 'uniqueConstraints', name), name).map((u) => ({
        name: asString(call(u, 'getName', name), name),
        columns: names(field(u, 'columns', name), name),
      })),
      ...indexes.map((c) => ({
        name: asString(field(c, 'name', name), name),
        columns: names(field(c, 'columns', name), name),
      })),
    ],
    checks: asArray(field(config, 'checks', name), name).map((c) =>
      asString(field(c, 'name', name), name),
    ),
  };
}

const tables = new Map<string, Table>();
for (const value of Object.values(schema) as unknown[]) {
  if (call(drizzle, 'is', 'drizzle-orm', value, PgTable) !== true) continue;
  const table = readTable(value);
  tables.set(table.name, table);
}

function tableNamed(name: string): Table {
  const table = tables.get(name);
  if (table === undefined) throw new Error(`no Drizzle table ${name}`);
  return table;
}

const EXEMPT = new Set(['workspaces', 'users', 'user_identities']);

/** The tenant column of a table: `id` for the root, none for a global table, else `workspace_id`. */
function tenantColumn(table: string): string | null {
  if (table === 'workspaces') return 'id';
  return EXEMPT.has(table) ? null : 'workspace_id';
}

function pairs(fk: ForeignKey): [string, string][] {
  return fk.columns.map((c, i) => [c, fk.refColumns[i] ?? '']);
}

function isPaired(table: string, fk: ForeignKey): boolean {
  const c = tenantColumn(table);
  const rc = tenantColumn(fk.refTable);
  return c !== null && rc !== null && pairs(fk).some(([a, b]) => a === c && b === rc);
}

/** The tenancy bucket `tenancy.test.ts` sorts a key into, re-derived from the Drizzle keys. */
function classOf(table: string, fk: ForeignKey): string {
  if (fk.refTable === 'workspaces' && fk.columns.length === 1 && isPaired(table, fk))
    return 'root-reference';
  if (EXEMPT.has(fk.refTable) && fk.refTable !== 'workspaces') return 'global-reference';
  if (isPaired(table, fk)) return 'tenant-paired';
  const tc = tenantColumn(table);
  const [c] = fk.columns;
  const [k] = fk.refColumns;
  const covered = tableNamed(table).foreignKeys.some(
    (g) =>
      g.refTable === fk.refTable &&
      isPaired(table, g) &&
      pairs(g).some(([a, b]) => a === c && b === k) &&
      g.columns.every((x) => x === c || x === tc),
  );
  return fk.columns.length === 1 && k === 'id' && covered ? 'sibling-paired' : 'unpaired';
}

/** Whether deleting the referenced row can never be refused because of this key. */
function clearsOnDelete(table: string, fk: ForeignKey): boolean {
  if (fk.onDelete === 'cascade' || fk.onDelete === 'set null') return true;
  if (fk.onDelete !== 'no action') return false;
  const tc = tenantColumn(table);
  const rest = fk.columns.filter((c) => c !== tc);
  return tableNamed(table).foreignKeys.some(
    (g) =>
      g.refTable === fk.refTable &&
      g.onDelete === 'set null' &&
      JSON.stringify(g.columns) === JSON.stringify(rest),
  );
}

function setNullSound(table: string, fk: ForeignKey): boolean {
  if (fk.onDelete !== 'set null') return true;
  const columns = tableNamed(table).columns;
  return fk.columns.every((c) => columns.find((col) => col.name === c)?.notNull === false);
}

function inbound(target: string): { table: string; fk: ForeignKey }[] {
  return [...tables.values()]
    .flatMap((t) => t.foreignKeys.map((fk) => ({ table: t.name, fk })))
    .filter(({ fk }) => fk.refTable === target);
}

const byName = <T extends { readonly name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------------------------

describe('configuration tables against the live Drizzle schema', () => {
  it.each(loadVectors(FAMILY, 'tables.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const name = asString(field(v.input, 'table', v.id), v.id);
    const expected = asRecord(v.expected, v.id);
    const table = tableNamed(name);

    const columns = asArray(expected['columns'], 'columns').map((c) => ({
      name: asString(field(c, 'name', 'column'), 'column'),
      type: asString(field(c, 'type', 'column'), 'column'),
      notNull: asBoolean(field(c, 'notNull', 'column'), 'column'),
    }));
    expect(table.columns).toEqual(columns);
    expect(table.primaryKey).toEqual(asStrings(expected['primaryKey'], 'primaryKey'));

    const foreignKeys = asArray(expected['foreignKeys'], 'foreignKeys').map((fk) => ({
      name: asString(field(fk, 'name', 'fk'), 'fk'),
      columns: asStrings(field(fk, 'columns', 'fk'), 'fk'),
      refTable: asString(field(fk, 'refTable', 'fk'), 'fk'),
      refColumns: asStrings(field(fk, 'refColumns', 'fk'), 'fk'),
      onDelete: asString(field(fk, 'onDelete', 'fk'), 'fk'),
      class: asString(field(fk, 'class', 'fk'), 'fk'),
    }));
    expect(byName(table.foreignKeys.map((fk) => ({ ...fk, class: classOf(name, fk) })))).toEqual(
      byName(foreignKeys),
    );

    const uniques = asArray(expected['uniques'], 'uniques').map((u) => ({
      name: asString(field(u, 'name', 'unique'), 'unique'),
      columns: asStrings(field(u, 'columns', 'unique'), 'unique'),
    }));
    expect(byName(table.uniques)).toEqual(byName(uniques));

    const checks = asArray(expected['checks'], 'checks').map((c) =>
      asString(field(c, 'name', 'check'), 'check'),
    );
    expect([...table.checks].sort()).toEqual([...checks].sort());

    const inboundExpected = asArray(expected['inbound'], 'inbound').map((r) => ({
      table: asString(field(r, 'table', 'inbound'), 'inbound'),
      name: asString(field(r, 'name', 'inbound'), 'inbound'),
      onDelete: asString(field(r, 'onDelete', 'inbound'), 'inbound'),
      clearsOnDelete: asBoolean(field(r, 'clearsOnDelete', 'inbound'), 'inbound'),
    }));
    const inboundActual = inbound(name).map(({ table: t, fk }) => ({
      table: t,
      name: fk.name,
      onDelete: fk.onDelete,
      clearsOnDelete: clearsOnDelete(t, fk),
    }));
    expect(byName(inboundActual)).toEqual(byName(inboundExpected));
    expect(
      inbound(name).every(({ table: t, fk }) => clearsOnDelete(t, fk) && setNullSound(t, fk)),
    ).toBe(asBoolean(expected['deleteNeverBlocked'], 'deleteNeverBlocked'));
  });
});

describe('foreign keys that touch the cluster', () => {
  const vectors = loadVectors(FAMILY, 'foreign-keys.json');
  const cluster = new Set([
    'model_connections',
    'runtime_profiles',
    'secrets',
    'storage_connections',
  ]);

  it('the model lists exactly the keys that start or end in a cluster table', () => {
    const actual = [...tables.values()]
      .flatMap((t) => t.foreignKeys.map((fk) => ({ table: t.name, fk })))
      .filter(({ table, fk }) => cluster.has(table) || cluster.has(fk.refTable))
      .map(({ fk }) => fk.name)
      .sort();
    expect(actual).toEqual(vectors.map((v) => asString(field(v.input, 'name', v.id), v.id)).sort());
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const table = asString(field(v.input, 'table', v.id), v.id);
    const fk = tableNamed(table).foreignKeys.find(
      (k) => k.name === asString(field(v.input, 'name', v.id), v.id),
    );
    if (fk === undefined) throw new Error(`${v.id}: no such key`);
    const expected = asRecord(v.expected, v.id);
    expect({
      refTable: fk.refTable,
      columns: fk.columns,
      refColumns: fk.refColumns,
      onDelete: fk.onDelete,
      class: classOf(table, fk),
    }).toEqual({
      refTable: asString(expected['refTable'], 'refTable'),
      columns: asStrings(expected['columns'], 'columns'),
      refColumns: asStrings(expected['refColumns'], 'refColumns'),
      onDelete: asString(expected['onDelete'], 'onDelete'),
      class: asString(expected['class'], 'class'),
    });
  });
});

// ---------------------------------------------------------------------------------------------

const snapshot: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, MODEL_SNAPSHOT), 'utf8'));

describe('refined checks against the latest snapshot', () => {
  it.each(loadVectors(FAMILY, 'checks.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const table = asString(field(v.input, 'table', v.id), v.id);
    const name = asString(field(v.input, 'name', v.id), v.id);
    const tableSnapshot = field(field(snapshot, 'tables', 'snapshot'), `public.${table}`, table);
    const check = field(field(tableSnapshot, 'checkConstraints', table), name, name);
    const body = asString(field(check, 'value', name), name);
    expect(asBoolean(field(v.expected, 'refined', v.id), v.id)).toBe(true);
    for (const fragment of asStrings(field(v.expected, 'fragments', v.id), v.id)) {
      expect(body).toContain(fragment);
    }
  });
});

// ---------------------------------------------------------------------------------------------

const ENUMS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  provider: [schema.modelProviders, MODEL_PROVIDERS],
  'config-field': [MODEL_CONNECTION_CONFIG_FIELDS],
  driver: [schema.runtimeProfileDrivers, RUNTIME_DRIVERS, runtimeDriverIds],
  'network-policy': [schema.runtimeProfileNetworkPolicies, RUNTIME_NETWORK_POLICIES],
  filesystem: [schema.runtimeProfileFilesystems, RUNTIME_FILESYSTEM_MODES],
  algorithm: [schema.secretAlgorithms],
};

describe('closed sets', () => {
  it.each(loadVectors(FAMILY, 'enums.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const name = asString(field(v.input, 'enum', v.id), v.id);
    const values = asStrings(field(v.expected, 'values', v.id), v.id);
    const arrays = ENUMS[name];
    if (arrays === undefined) throw new Error(`${v.id}: no TypeScript array for ${name}`);
    for (const array of arrays) expect([...array]).toEqual(values);
    const ddl = field(v.expected, 'ddl', v.id);
    if (ddl === null) expect(() => schema.renderValueList(values)).toThrow();
    else expect(schema.renderValueList(values)).toBe(asString(ddl, v.id));
  });
});

// ---------------------------------------------------------------------------------------------

function asProvider(value: unknown, what: string): ModelProvider {
  const found = MODEL_PROVIDERS.find((p) => p === value);
  if (found === undefined) throw new Error(`${what}: not a provider`);
  return found;
}

describe('the provider config rule table', () => {
  it.each(loadVectors(FAMILY, 'config-rules.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const provider = asProvider(field(v.input, 'provider', v.id), v.id);
      const rule = MODEL_PROVIDER_CONFIG_RULES[provider];
      expect([...rule.allowed].sort()).toEqual(
        asStrings(field(v.expected, 'allowed', v.id), v.id).sort(),
      );
      expect([...rule.required].sort()).toEqual(
        asStrings(field(v.expected, 'required', v.id), v.id).sort(),
      );
    },
  );
});

describe('secret names against SECRET_NAME_PATTERN and SecretResourceSchema', () => {
  const nameSchema = SecretResourceSchema.unwrap().shape.name;
  it.each(loadVectors(FAMILY, 'secret-names.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const name = asString(v.input, v.id);
      const valid = asBoolean(field(v.expected, 'valid', v.id), v.id);
      expect(SECRET_NAME_PATTERN.test(name)).toBe(valid);
      expect(nameSchema.safeParse(name).success).toBe(valid);
    },
  );
});

// ---------------------------------------------------------------------------------------------

const RESOURCE_SCHEMAS = {
  secret: SecretResourceSchema,
  'model-connection': ModelConnectionResourceSchema,
  'runtime-profile': RuntimeProfileResourceSchema,
  'runtime-connection': RuntimeConnectionResourceSchema,
} as const;

function resourceSchema(name: string): (typeof RESOURCE_SCHEMAS)[keyof typeof RESOURCE_SCHEMAS] {
  const found = Object.entries(RESOURCE_SCHEMAS).find(([key]) => key === name);
  if (found === undefined) throw new Error(`no resource schema ${name}`);
  return found[1];
}

describe('wire resources carry no credential', () => {
  it.each(loadVectors(FAMILY, 'resources.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const input = asRecord(v.input, v.id);
    const zod = resourceSchema(asString(input['resource'], v.id));
    const fields = asStrings(field(v.expected, 'fields', v.id), v.id);
    expect(Object.keys(zod.unwrap().shape).sort()).toEqual([...fields].sort());
    expect(fields.includes('workspaceId')).toBe(
      asBoolean(field(v.expected, 'carriesWorkspaceId', v.id), v.id),
    );
    const sample = asRecord(input['sample'], v.id);
    expect(zod.safeParse(sample).success).toBe(true);
    for (const forbidden of asStrings(input['forbidden'], v.id)) {
      expect(zod.safeParse({ ...sample, [forbidden]: 'sk-ant-secret' }).success).toBe(false);
    }
  });
});

describe('runtime-profile names: the contract against runtime_profiles_name_not_blank', () => {
  const checks = field(
    field(field(snapshot, 'tables', 'snapshot'), 'public.runtime_profiles', 'snapshot'),
    'checkConstraints',
    'runtime_profiles',
  );
  const check = field(checks, 'runtime_profiles_name_not_blank', 'runtime_profiles');
  const body = asString(field(check, 'value', 'check'), 'runtime_profiles_name_not_blank');

  it('the database check trims with btrim, which strips spaces only', () => {
    expect(body).toBe('length(btrim("runtime_profiles"."name")) > 0');
  });

  it.each(loadVectors(FAMILY, 'profile-names.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const name = asString(v.input, v.id);
      const expected = asRecord(v.expected, v.id);
      const accepted = asBoolean(expected['contractAccepted'], 'contractAccepted');
      expect(RuntimeProfileResourceSchema.unwrap().shape.name.safeParse(name).success).toBe(
        accepted,
      );
      expect(CreateRuntimeProfileInput.shape.name.safeParse(name).success).toBe(accepted);
      // PostgreSQL's `btrim(text)` removes the space character only (not tabs or newlines).
      expect(name.replace(/^ +| +$/gu, '').length > 0).toBe(
        asBoolean(expected['databaseAccepted'], 'databaseAccepted'),
      );
    },
  );
});

describe('numbers: contract acceptance and the integer columns', () => {
  const shape = RuntimeProfileResourceSchema.unwrap().shape;
  const createShape = CreateRuntimeProfileInput.shape;
  const INT4_MIN = -2147483648;
  const INT4_MAX = 2147483647;

  it('the sizing and timeout columns are PostgreSQL integers', () => {
    const columns = tableNamed('runtime_profiles').columns;
    for (const c of ['cpu', 'memory_mb', 'disk_mb', 'timeout_seconds', 'idle_timeout_seconds']) {
      expect(columns.find((col) => col.name === c)?.type).toBe('integer');
    }
  });

  it.each(loadVectors(FAMILY, 'numbers.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const n = asNumber(v.input, v.id);
    const expected = asRecord(v.expected, v.id);
    const cpu = asBoolean(expected['cpuAccepted'], 'cpuAccepted');
    const size = asBoolean(expected['sizeAccepted'], 'sizeAccepted');
    expect(shape.cpu.safeParse(n).success).toBe(cpu);
    expect(createShape.cpu.safeParse(n).success).toBe(cpu);
    for (const key of ['memoryMb', 'diskMb', 'timeoutSeconds', 'idleTimeoutSeconds'] as const) {
      expect(shape[key].safeParse(n).success).toBe(size);
      expect(createShape[key].safeParse(n).success).toBe(size);
    }
    expect(Number.isInteger(n) && n >= INT4_MIN && n <= INT4_MAX).toBe(
      asBoolean(expected['integerColumnAccepts'], 'integerColumnAccepts'),
    );
  });
});

const VALID_PROFILE: Readonly<Record<string, unknown>> = {
  name: 'default',
  driver: 'docker',
  runtimeConnectionId: 's1',
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  networkPolicy: 'none',
  allowedDomains: ['example.com'],
  filesystem: 'read-write',
  persistPaths: ['/work'],
  timeoutSeconds: 60,
  idleTimeoutSeconds: 30,
  driverConfig: {},
};

const PROFILE_SCHEMAS = {
  'runtime-profile-create': CreateRuntimeProfileInput,
  'runtime-profile-update': UpdateRuntimeProfileInput,
} as const;

function profileSchema(
  name: string,
): (typeof PROFILE_SCHEMAS)[keyof typeof PROFILE_SCHEMAS] | undefined {
  return Object.entries(PROFILE_SCHEMAS).find(([key]) => key === name)?.[1];
}

describe('the runtime-profile request bodies against CreateRuntimeProfileInput and UpdateRuntimeProfileInput', () => {
  const vectors = loadVectors(FAMILY, 'request-fields.json').filter(
    (v) => profileSchema(asString(field(v.input, 'request', v.id), v.id)) !== undefined,
  );

  it('the family carries the runtime-profile create and update vectors', () => {
    expect(vectors.map((v) => asString(field(v.input, 'request', v.id), v.id)).sort()).toEqual(
      Object.keys(PROFILE_SCHEMAS).sort(),
    );
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const zod = profileSchema(asString(field(v.input, 'request', v.id), v.id));
    if (zod === undefined) throw new Error(`${v.id}: no schema`);
    const expected = asRecord(v.expected, v.id);
    const fields = asStrings(expected['fields'], 'fields');
    const required = asStrings(expected['required'], 'required');
    const shape: Readonly<
      Record<string, { safeParse: (value: unknown) => { readonly success: boolean } }>
    > = zod.shape;
    expect(Object.keys(shape).sort()).toEqual([...fields].sort());
    expect(
      Object.entries(shape)
        .filter(([, schema]) => !schema.safeParse(undefined).success)
        .map(([key]) => key)
        .sort(),
    ).toEqual([...required].sort());
    expect(Object.keys(VALID_PROFILE).sort()).toEqual([...fields].sort());
    expect(zod.safeParse(VALID_PROFILE).success).toBe(
      asBoolean(expected['fullBodyAccepted'], 'fullBodyAccepted'),
    );
    expect(zod.safeParse({}).success).toBe(
      asBoolean(expected['emptyBodyAccepted'], 'emptyBodyAccepted'),
    );
    for (const key of fields) {
      const body = Object.fromEntries(Object.entries(VALID_PROFILE).filter(([k]) => k !== key));
      expect([key, zod.safeParse(body).success]).toEqual([key, !required.includes(key)]);
    }
    expect(asBoolean(expected['refusesUnknown'], v.id)).toBe(
      !zod.safeParse({ ...VALID_PROFILE, bogus: 'x' }).success,
    );
    expect(asStrings(expected['ignored'], 'ignored')).toEqual([]);
    for (const key of asStrings(expected['refused'], 'refused')) {
      expect([key, zod.safeParse({ ...VALID_PROFILE, [key]: 'x' }).success]).toEqual([key, false]);
    }
  });
});

describe('runtime-profile PATCH with null against UpdateRuntimeProfileInput', () => {
  it.each(loadVectors(FAMILY, 'profile-patch.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const key = asString(field(v.input, 'field', v.id), v.id);
      const kind = asString(field(v.input, 'value', v.id), v.id);
      const value = kind === 'null' ? null : VALID_PROFILE[key];
      expect(value).not.toBeUndefined();
      expect(UpdateRuntimeProfileInput.safeParse({ [key]: value }).success).toBe(
        asBoolean(field(v.expected, 'acceptedToday', v.id), v.id),
      );
      // The resource renders an absent optional field as null exactly for the nullable fields.
      expect(RuntimeProfileResourceSchema.unwrap().shape).toHaveProperty(key);
      const resourceField = Object.entries(RuntimeProfileResourceSchema.unwrap().shape).find(
        ([k]) => k === key,
      )?.[1];
      expect(resourceField?.safeParse(null).success).toBe(
        asBoolean(field(v.expected, 'nullable', v.id), v.id),
      );
    },
  );
});

describe("the model's blank set against JavaScript's trim", () => {
  it.each(loadVectors(FAMILY, 'trim.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const from = asNumber(field(v.input, 'from', v.id), v.id);
    const to = asNumber(field(v.input, 'to', v.id), v.id);
    const expected = asArray(field(v.expected, 'codePoints', v.id), v.id).map((n) =>
      asNumber(n, v.id),
    );
    const actual: number[] = [];
    for (let n = from; n <= to; n += 1) {
      if (String.fromCharCode(n).trim() === '') actual.push(n);
    }
    expect(actual).toEqual(expected);
  });
});
