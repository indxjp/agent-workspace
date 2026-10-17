/**
 * Differential conformance for the `authz-tenancy` family (package half): the Lean tenancy model
 * (formal/AgentWorkspace/Authz/Tenancy.lean) replayed against the REAL package code, through the
 * package exports:
 *
 *   - `createInMemoryWorkspaceScopeResolver` and `requireWorkspaceScope` (`@agent-workspace/core/db`);
 *   - `createScopedObjectStore` over a recording backend (`@agent-workspace/core/storage`): which
 *     backend keys each call reaches, which keys and workspace ids it refuses, and the two
 *     workspaces whose calls reach one key today;
 *   - `validateTenantSessionScope` (`@agent-workspace/core`);
 *   - `tenancy.test.ts` rule 1 per table, recomputed from the live Drizzle tables (F-007).
 *
 * The application half (run concealment, principal selection, the workspace resolvers and
 * `authorise`) is `apps/web/formal/authz-tenancy.test.ts` (decision D-012).
 */
import { validateTenantSessionScope } from '@agent-workspace/core';
import {
  createInMemoryWorkspaceScopeResolver,
  ForgedWorkspaceScopeError,
  requireWorkspaceScope,
  WorkspaceScope,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import * as schema from '@agent-workspace/core/db/unscoped';
import {
  createScopedObjectStore,
  InvalidWorkspaceIdError,
  UnsafeObjectKeyError,
  type ObjectListEntry,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import * as drizzleModule from 'drizzle-orm';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'authz-tenancy';

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array, got ${String(value)}`);
  return value as readonly unknown[];
}

function asStrings(value: unknown, what: string): string[] {
  return asArray(value, what).map((v, i) => asString(v, `${what}[${String(i)}]`));
}

function field(value: unknown, key: string, what: string): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${what}: expected an object with ${key}`);
  }
  return Reflect.get(value, key) as unknown;
}

function call(value: unknown, method: string, what: string, ...args: unknown[]): unknown {
  const fn = field(value, method, what);
  if (typeof fn !== 'function') throw new Error(`${what}: ${method} is not a function`);
  return Reflect.apply(fn, value, args) as unknown;
}

// ---------------------------------------------------------------------------------------------
// The workspace scope.

describe('createInMemoryWorkspaceScopeResolver', () => {
  it.each(loadVectors(FAMILY, 'scope-resolver.json').map((v) => [v.id, v] as const))(
    '%s',
    async (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const known = asArray(input['known'], `${vector.id} known`).map((k) => {
        const row = asRecord(k, `${vector.id} known row`);
        return { id: asString(row['id'], 'id'), slug: asString(row['slug'], 'slug') };
      });
      const resolver: WorkspaceScopeResolver = createInMemoryWorkspaceScopeResolver(known);
      const key = asString(input['key'], `${vector.id} key`);
      const scope =
        input['by'] === 'id'
          ? await resolver.forWorkspaceId(key)
          : await resolver.forWorkspaceSlug(key);
      const expected = asRecord(vector.expected, vector.id);
      expect(scope === null ? null : scope.workspaceId).toBe(expected['workspaceId']);
      // A resolver's scope is a minted one: the run-time gate admits it unchanged.
      if (scope !== null) expect(requireWorkspaceScope(scope, 'conformance')).toBe(scope);
    },
  );
});

async function mintedScope(workspaceId: string): Promise<WorkspaceScope> {
  const scope = await createInMemoryWorkspaceScopeResolver([
    { id: workspaceId, slug: 'forgery-slug' },
  ]).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('the in-memory resolver refused a known workspace');
  return scope;
}

async function scopeValue(kind: string, workspaceId: string): Promise<unknown> {
  switch (kind) {
    case 'minted':
      return mintedScope(workspaceId);
    case 'cast-literal':
      return { workspaceId };
    case 'prototype-instance': {
      const forged: unknown = Object.create(WorkspaceScope.prototype);
      Reflect.set(forged as object, 'workspaceId', workspaceId);
      return forged;
    }
    case 'null':
      return null;
    case 'string':
      return workspaceId;
    case 'number':
      return 42;
    default:
      throw new Error(`unknown forgery kind ${kind}`);
  }
}

describe('requireWorkspaceScope', () => {
  it.each(loadVectors(FAMILY, 'scope-forgery.json').map((v) => [v.id, v] as const))(
    '%s',
    async (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const expected = asRecord(vector.expected, vector.id);
      const value = await scopeValue(
        asString(input['kind'], 'kind'),
        asString(input['workspaceId'], 'workspaceId'),
      );
      if (expected['accepted'] === true) {
        const scope = requireWorkspaceScope(value, 'conformance');
        expect(scope.workspaceId).toBe(expected['workspaceId']);
      } else {
        expect(() => requireWorkspaceScope(value, 'conformance')).toThrow(
          ForgedWorkspaceScopeError,
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The scoped object store.

/** A backend that stores nothing and records every key it is handed, in call order. */
function recordingBackend(): { readonly store: ObjectStore; readonly keys: string[] } {
  const keys: string[] = [];
  const store: ObjectStore = {
    put: (key) => {
      keys.push(key);
      return Promise.resolve();
    },
    get: (key) => {
      keys.push(key);
      return Promise.resolve(null);
    },
    delete: (key) => {
      keys.push(key);
      return Promise.resolve();
    },
    list: (prefix): Promise<readonly ObjectListEntry[]> => {
      keys.push(prefix);
      return Promise.resolve([]);
    },
    listPrefix: (prefix): Promise<readonly ObjectListEntry[]> => {
      keys.push(prefix);
      return Promise.resolve([]);
    },
    copyObject: (source, destination) => {
      keys.push(source, destination);
      return Promise.resolve();
    },
  };
  return { store, keys };
}

type ObjectOutcome =
  | { readonly kind: 'invalid-workspace-id' }
  | { readonly kind: 'unsafe-key'; readonly rule: string }
  | { readonly kind: 'backend'; readonly keys: readonly string[] };

async function runObjectCall(workspaceId: string, callInput: unknown): Promise<ObjectOutcome> {
  const backend = recordingBackend();
  let scoped: ObjectStore;
  try {
    scoped = createScopedObjectStore(backend.store, workspaceId);
  } catch (error) {
    if (error instanceof InvalidWorkspaceIdError) return { kind: 'invalid-workspace-id' };
    throw error;
  }
  const c = asRecord(callInput, 'call');
  const text = (key: string): string => asString(c[key], key);
  try {
    switch (c['op']) {
      case 'put':
        await scoped.put(text('key'), { body: new Uint8Array() });
        break;
      case 'get':
        await scoped.get(text('key'));
        break;
      case 'delete':
        await scoped.delete(text('key'));
        break;
      case 'list':
        await scoped.list(text('prefix'));
        break;
      case 'listPrefix':
        await scoped.listPrefix(text('prefix'));
        break;
      case 'copy':
        await scoped.copyObject(text('src'), text('dst'));
        break;
      default:
        throw new Error(`unknown object call ${JSON.stringify(c)}`);
    }
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return { kind: 'unsafe-key', rule: error.rule };
    throw error;
  }
  return { kind: 'backend', keys: backend.keys };
}

const objectVectors = loadVectors(FAMILY, 'object-keys.json');

describe('createScopedObjectStore', () => {
  it.each(objectVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(asRecord(vector.expected, vector.id)['current'], vector.id);
    const actual = await runObjectCall(
      asString(input['workspaceId'], 'workspaceId'),
      input['call'],
    );
    expect(actual.kind).toBe(expected['kind']);
    if (actual.kind === 'backend') {
      expect(actual.keys).toEqual(asStrings(expected['keys'], `${vector.id} keys`));
    }
    if (actual.kind === 'unsafe-key' && expected['ruleExact'] === true) {
      expect(actual.rule).toBe(expected['rule']);
    }
  });

  it('two workspaces reach one backend key today: "a" + "b/c" and "a/b" + "c" (finding)', async () => {
    const first = await runObjectCall('a', { op: 'put', key: 'b/c' });
    const second = await runObjectCall('a/b', { op: 'put', key: 'c' });
    expect(first).toEqual({ kind: 'backend', keys: ['workspaces/a/b/c'] });
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------------------------
// The tenant session scope.

describe('validateTenantSessionScope', () => {
  it.each(loadVectors(FAMILY, 'tenant-session-scope.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, vector) => {
      const expected = asRecord(vector.expected, vector.id);
      const verdict = validateTenantSessionScope(vector.input);
      expect(verdict.ok).toBe(expected['ok']);
      if (verdict.ok) {
        expect(verdict.projectKey).toBe(expected['projectKey']);
        expect(verdict.configDir).toBe(expected['configDir']);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// tenancy.test.ts rule 1, per table (F-007).

const pgCore: unknown = pgCoreModule;
const drizzle: unknown = drizzleModule;
const PgTable = field(pgCore, 'PgTable', 'drizzle-orm/pg-core');
const TABLE_NAME = Symbol.for('drizzle:Name');

interface Rule1Shape {
  readonly leading: ReadonlySet<string>;
  readonly workspaceIdNotNull: boolean | null;
  readonly rootReferences: readonly { readonly table: string; readonly columns: string[] }[];
}

function columnName(entry: unknown): string | undefined {
  if (call(drizzle, 'is', 'drizzle-orm', entry, field(drizzle, 'SQL', 'drizzle-orm')) === true) {
    return undefined;
  }
  const name = field(entry, 'name', 'index entry');
  return typeof name === 'string' ? name : undefined;
}

function readRule1(table: unknown): Rule1Shape {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const leading = new Set<string>();
  for (const index of asArray(field(config, 'indexes', 'config'), 'indexes')) {
    const first = asArray(field(field(index, 'config', 'index'), 'columns', 'index'), 'columns')[0];
    const name = first === undefined ? undefined : columnName(first);
    if (name !== undefined) leading.add(name);
  }
  for (const unique of asArray(field(config, 'uniqueConstraints', 'config'), 'uniques')) {
    const first = asArray(field(unique, 'columns', 'unique'), 'columns')[0];
    const name = first === undefined ? undefined : columnName(first);
    if (name !== undefined) leading.add(name);
  }
  const workspaceColumn = asArray(field(config, 'columns', 'config'), 'columns').find(
    (c) => field(c, 'name', 'column') === 'workspace_id',
  );
  const rootReferences = asArray(field(config, 'foreignKeys', 'config'), 'foreignKeys')
    .map((fk) => call(fk, 'reference', 'fk'))
    .filter((reference) => {
      const columns = asArray(field(reference, 'columns', 'reference'), 'columns');
      return columns.length === 1 && field(columns[0], 'name', 'column') === 'workspace_id';
    })
    .map((reference) => ({
      table: asString(
        Reflect.get(field(reference, 'foreignTable', 'reference') as object, TABLE_NAME),
        'foreign table',
      ),
      columns: asArray(field(reference, 'foreignColumns', 'reference'), 'foreign columns').map(
        (c) => asString(field(c, 'name', 'column'), 'column'),
      ),
    }));
  return {
    leading,
    workspaceIdNotNull:
      workspaceColumn === undefined ? null : field(workspaceColumn, 'notNull', 'column') === true,
    rootReferences,
  };
}

const drizzleTables = new Map<string, unknown>();
for (const value of Object.values(schema) as unknown[]) {
  if (call(drizzle, 'is', 'drizzle-orm', value, PgTable) !== true) continue;
  const name = asString(Reflect.get(value as object, TABLE_NAME), 'table name');
  drizzleTables.set(name, value);
}

describe('tenancy.test.ts rule 1, table by table', () => {
  const vectors = loadVectors(FAMILY, 'tenancy-rule.json');

  it('covers exactly the tables the schema exports', () => {
    expect(vectors.map((v) => asString(asRecord(v.input, v.id)['table'], v.id)).sort()).toEqual(
      [...drizzleTables.keys()].sort(),
    );
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const tableName = asString(asRecord(vector.input, vector.id)['table'], vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const shape = readRule1(drizzleTables.get(tableName));
    expect([...shape.leading].sort()).toEqual(
      [...new Set(asStrings(expected['leadingIndexedColumns'], vector.id))].sort(),
    );
    const exempt = expected['tenancy'] !== 'scoped';
    const [rootReference] = shape.rootReferences;
    const rule1 = exempt
      ? shape.workspaceIdNotNull === null
      : shape.workspaceIdNotNull === true &&
        shape.rootReferences.length === 1 &&
        rootReference?.table === 'workspaces' &&
        rootReference.columns.join(',') === 'id' &&
        shape.leading.has('workspace_id');
    expect(rule1).toBe(expected['testRule1']);
    // F-007: on today's catalogue the model's rule and the test's agree, table by table.
    expect(expected['modelRule']).toBe(expected['testRule1']);
  });
});
