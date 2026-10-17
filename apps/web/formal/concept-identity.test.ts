/**
 * Differential conformance for the `concept-identity` family: the Lean model of workspaces,
 * users, memberships, principals, API keys, invitations and browser tokens
 * (formal/AgentWorkspace/Concepts/*.lean, Er/Current/Identity.lean) replayed against the REAL
 * TypeScript:
 *
 *   - the enumerations against the contracts, the Drizzle schema and the server's own lists, and
 *     `parseRole` / `wireKind`;
 *   - the 36 refined checks against the CHECK bodies `drizzle-kit` recorded in
 *     `migrations/meta/0051_snapshot.json`, and the pattern checks' boundary rows against the
 *     snapshot's own regular expressions;
 *   - every foreign key and unique key of the cluster against the live Drizzle table objects
 *     (columns, target, `ON DELETE`, and the multiplicities the model derives);
 *   - the `Principal` constructors (`ownerPrincipalId` included), `isPrincipal` and `readMe` against the model's actors,
 *     `isPrincipal` against hand-built actors (every kind × verifier × scope × id presence × owner), and
 *     `MeResponseSchema` against the model's `me` bodies;
 *   - the bearer grammars and the `ak_live_<key id>` display prefix;
 *   - `invitationStateOf`, `MintTokenRequestSchema`, and the resource schemas' field lists.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_KEY_DISPLAY_PREFIX_PATTERN,
  API_KEY_ID_LENGTH,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  ApiKeyResourceSchema,
} from '@indx-workspace/contracts/api-keys';
import {
  INVITATION_TOKEN_MAX_LENGTH,
  InvitationResourceSchema,
} from '@indx-workspace/contracts/invitations';
import {
  MEMBERSHIP_ROLES,
  MeResponseSchema,
  PRINCIPAL_KINDS as WIRE_PRINCIPAL_KINDS,
  USER_EMAIL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
} from '@indx-workspace/contracts/team';
import {
  BROWSER_TOKEN_DEFAULT_TTL_SECONDS,
  BROWSER_TOKEN_ID_LENGTH,
  BROWSER_TOKEN_PATTERN,
  BROWSER_TOKEN_PREFIX,
  BROWSER_TOKEN_SECRET_LENGTH,
  MintTokenRequestSchema,
  TOKEN_SCOPE_KINDS,
} from '@indx-workspace/contracts/tokens';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_SLUG_MAX_LENGTH,
} from '@indx-workspace/contracts/workspaces';
import * as schema from '@agent-workspace/core/db/unscoped';
import * as drizzleModule from 'drizzle-orm';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { invitationStateOf } from '../components/team/invitations-model';
import {
  API_KEY_PREFIX as SERVER_API_KEY_PREFIX,
  KEY_ID_LENGTH as SERVER_KEY_ID_LENGTH,
  parsePresentedKey,
  SECRET_LENGTH as SERVER_KEY_SECRET_LENGTH,
} from '../server/rbac/api-key';
import {
  BROWSER_TOKEN_ID_LENGTH as SERVER_BROWSER_TOKEN_ID_LENGTH,
  BROWSER_TOKEN_PREFIX as SERVER_BROWSER_TOKEN_PREFIX,
  BROWSER_TOKEN_SECRET_LENGTH as SERVER_BROWSER_TOKEN_SECRET_LENGTH,
  parsePresentedBrowserToken,
} from '../server/rbac/browser-token';
import { readMe, wireKind } from '../server/rbac/handlers';
import {
  PRINCIPAL_KINDS,
  Principal,
  TOKEN_SCOPE_KINDS as SERVER_TOKEN_SCOPE_KINDS,
  type PrincipalKind,
  type TokenScope,
} from '../server/rbac/principal';
import { parseRole, ROLES, type Role } from '../server/rbac/roles';
import { asRecord, asString, loadVectors, type FormalVector } from '../../../tests/formal/vectors';

const FAMILY = 'concept-identity';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// ---------------------------------------------------------------------------------------------
// Narrowing helpers: everything read from JSON or Drizzle is `unknown` until checked.

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

function asNullableString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function field(value: unknown, key: string, what: string): unknown {
  return asRecord(value, what)[key];
}

function call(value: unknown, method: string, what: string, ...args: unknown[]): unknown {
  const fn = field(value, method, what);
  if (typeof fn !== 'function') throw new Error(`${what}: ${method} is not a function`);
  return Reflect.apply(fn, value, args) as unknown;
}

function isServerKind(value: string): value is PrincipalKind {
  return PRINCIPAL_KINDS.some((kind) => kind === value);
}

function asServerKind(value: unknown, what: string): PrincipalKind {
  const text = asString(value, what);
  if (!isServerKind(text)) throw new Error(`${what}: ${text} is not a principal kind`);
  return text;
}

function asRole(value: unknown, what: string): Role {
  const role = parseRole(value);
  if (role === null) throw new Error(`${what}: ${JSON.stringify(value)} is not a role`);
  return role;
}

function asScope(value: unknown, what: string): TokenScope {
  const kind = asString(field(value, 'kind', what), `${what}.kind`);
  const id = asString(field(value, 'id', what), `${what}.id`);
  if (kind !== 'run' && kind !== 'session') throw new Error(`${what}: bad scope kind ${kind}`);
  return { kind, id };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

// ---------------------------------------------------------------------------------------------
// The live Drizzle tables and the drizzle-kit snapshot.

const pgCore: unknown = pgCoreModule;
const drizzle: unknown = drizzleModule;
const PgTable = field(pgCore, 'PgTable', 'drizzle-orm/pg-core');

interface ForeignKeyShape {
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: string;
}
interface TableShape {
  readonly primaryKey: readonly string[];
  readonly notNull: ReadonlySet<string>;
  readonly foreignKeys: ReadonlyMap<string, ForeignKeyShape>;
  /** Total (non-partial) unique keys: constraints and unique indexes without `WHERE`. */
  readonly uniques: ReadonlyMap<string, readonly string[]>;
}

function columnNames(columns: unknown, what: string): string[] {
  return asArray(columns, what).map((c) => asString(field(c, 'name', what), what));
}

function readTable(table: unknown): [string, TableShape] {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const name = asString(field(config, 'name', 'table config'), 'table config name');
  const columns = asArray(field(config, 'columns', name), `${name}.columns`);
  const composite = asArray(field(config, 'primaryKeys', name), `${name}.primaryKeys`);
  const primaryKey =
    composite.length > 0
      ? columnNames(field(composite[0], 'columns', name), name)
      : columns
          .filter((c) => field(c, 'primary', name) === true)
          .map((c) => asString(field(c, 'name', name), name));
  const notNull = new Set(
    columns
      .filter((c) => field(c, 'notNull', name) === true)
      .map((c) => asString(field(c, 'name', name), name)),
  );
  const foreignKeys = new Map<string, ForeignKeyShape>();
  for (const fk of asArray(field(config, 'foreignKeys', name), `${name}.foreignKeys`)) {
    const fkName = asString(call(fk, 'getName', name), `${name} fk`);
    const reference = call(fk, 'reference', fkName);
    const onDelete = field(fk, 'onDelete', fkName);
    const refTable = field(reference, 'foreignTable', fkName);
    foreignKeys.set(fkName, {
      columns: columnNames(field(reference, 'columns', fkName), fkName),
      refTable: asString(
        Reflect.get(asRecord(refTable, fkName), Symbol.for('drizzle:Name')),
        `${fkName} target`,
      ),
      refColumns: columnNames(field(reference, 'foreignColumns', fkName), fkName),
      onDelete: onDelete === undefined ? 'no action' : asString(onDelete, `${fkName} onDelete`),
    });
  }
  const uniques = new Map<string, readonly string[]>();
  for (const u of asArray(field(config, 'uniqueConstraints', name), `${name}.unique`)) {
    uniques.set(
      asString(call(u, 'getName', name), name),
      columnNames(field(u, 'columns', name), name),
    );
  }
  for (const index of asArray(field(config, 'indexes', name), `${name}.indexes`)) {
    const indexConfig = field(index, 'config', name);
    if (field(indexConfig, 'unique', name) !== true) continue;
    if (field(indexConfig, 'where', name) !== undefined) continue;
    uniques.set(
      asString(field(indexConfig, 'name', name), name),
      columnNames(field(indexConfig, 'columns', name), name),
    );
  }
  return [name, { primaryKey, notNull, foreignKeys, uniques }];
}

const tables = new Map<string, TableShape>(
  Object.values(schema as Record<string, unknown>)
    .filter((value) => call(drizzle, 'is', 'drizzle-orm', value, PgTable) === true)
    .map(readTable),
);

function tableShape(name: string): TableShape {
  const shape = tables.get(name);
  if (shape === undefined) throw new Error(`the Drizzle schema has no table ${name}`);
  return shape;
}

const snapshot: unknown = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'migrations/meta/0051_snapshot.json'), 'utf8'),
);

function snapshotCheck(table: string, check: string): string {
  const raw = Object.values(
    asRecord(field(snapshot, 'tables', 'snapshot'), 'snapshot tables'),
  ).find((t) => field(t, 'name', 'snapshot table') === table);
  const body = field(
    asRecord(field(raw, 'checkConstraints', table), `${table}.checkConstraints`)[check],
    'value',
    check,
  );
  return asString(body, `${table}.${check}`);
}

/**
 * The regular expression of a `column ~ '<re>'` check body, as a JavaScript `RegExp`. The one
 * POSIX construct the schema uses, `[:space:]` inside a bracket expression, becomes the C-locale
 * whitespace set it denotes.
 */
function checkRegExp(body: string): RegExp {
  const match = /~ '(.*)'$/su.exec(body);
  if (match?.[1] === undefined) throw new Error(`not a regular-expression check: ${body}`);
  return new RegExp(match[1].replaceAll('[:space:]', ' \\t\\n\\v\\f\\r'), 'u');
}

/** The fourteen tables of the cluster, as the model lists them. */
const clusterTables: readonly string[] = (() => {
  const vector = loadVectors(FAMILY, 'constants.json').find((v) => v.id === 'tables');
  if (vector === undefined) throw new Error('no cluster table list');
  return asStrings(field(vector.expected, 'tables', vector.id), vector.id);
})();

// ---------------------------------------------------------------------------------------------

describe('concept-identity: enumerations', () => {
  const vectors = loadVectors(FAMILY, 'enums.json');
  const members = (name: string): string[] => {
    const vector = vectors.find((v) => field(v.input, 'enum', v.id) === name);
    if (vector === undefined) throw new Error(`no enumeration vector ${name}`);
    return asStrings(field(vector.expected, 'members', vector.id), vector.id);
  };

  it('roles are MEMBERSHIP_ROLES, the schema membershipRoles and the server ROLES, in order', () => {
    expect(members('role')).toEqual([...MEMBERSHIP_ROLES]);
    expect(members('role')).toEqual([...schema.membershipRoles]);
    expect(members('role')).toEqual([...ROLES]);
  });

  it('principal kinds: the wire spelling and the storage spelling', () => {
    expect(members('principal-kind-wire')).toEqual([...WIRE_PRINCIPAL_KINDS]);
    expect(members('principal-kind-storage')).toEqual([...schema.workspacePrincipalKinds]);
    expect(members('principal-kind-storage')).toEqual([...PRINCIPAL_KINDS]);
  });

  it('scope kinds are the contract, server and schema lists', () => {
    expect(members('scope-kind')).toEqual([...TOKEN_SCOPE_KINDS]);
    expect(members('scope-kind')).toEqual([...SERVER_TOKEN_SCOPE_KINDS]);
    expect(members('scope-kind')).toEqual([...schema.browserTokenScopeKinds]);
  });

  const parseVectors = vectors.filter((v) => v.id.startsWith('parse-role/'));
  it.each(parseVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const expected = asNullableString(field(vector.expected, 'role', vector.id), vector.id);
    expect(parseRole(field(vector.input, 'value', vector.id))).toBe(expected);
  });

  const wireVectors = vectors.filter((v) => v.id.startsWith('wire-kind/'));
  it.each(wireVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const storage = asString(field(vector.input, 'storage', vector.id), vector.id);
    const expected = asNullableString(field(vector.expected, 'wire', vector.id), vector.id);
    if (isServerKind(storage)) expect(wireKind(storage)).toBe(expected);
    else expect(expected).toBeNull();
  });

  it('the verifiers and invitation states the model lists are the ones the code produces', () => {
    const vias = new Set(
      loadVectors(FAMILY, 'principals.json').map((v) =>
        asString(field(field(v.expected, 'principal', v.id), 'via', v.id), v.id),
      ),
    );
    expect([...vias].sort()).toEqual([...members('via')].sort());
    const states = new Set(
      loadVectors(FAMILY, 'invitation-states.json').map((v) =>
        asString(field(v.expected, 'state', v.id), v.id),
      ),
    );
    expect([...states].sort()).toEqual([...members('invitation-state')].sort());
  });
});

describe('concept-identity: the refined checks', () => {
  const vectors = loadVectors(FAMILY, 'checks.json');
  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const table = asString(field(vector.input, 'table', vector.id), vector.id);
    const check = asString(field(vector.input, 'check', vector.id), vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const body = snapshotCheck(table, check);
    expect(asString(expected['sql'], vector.id)).toBe(body);
    const accepted = asArray(expected['accepted'], vector.id);
    const refused = asArray(expected['refused'], vector.id);
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    if (expected['pattern'] === null) return;
    const column = asString(expected['column'], vector.id);
    const pattern = checkRegExp(body);
    for (const row of accepted) {
      const cell = field(row, column, vector.id);
      if (cell === undefined) continue;
      const value = asString(cell, vector.id);
      expect(pattern.test(value), value).toBe(true);
    }
    for (const row of refused) {
      const value = asString(field(row, column, vector.id), vector.id);
      expect(pattern.test(value), value).toBe(false);
    }
  });

  it('covers exactly the non-closed-set checks of the fourteen identity tables', () => {
    const identityTables = new Set(clusterTables);
    const modelled = new Set(vectors.map((v) => asString(field(v.input, 'check', v.id), v.id)));
    const snapshotChecks = Object.values(
      asRecord(field(snapshot, 'tables', 'snapshot'), 'snapshot tables'),
    )
      .filter((t) => identityTables.has(asString(field(t, 'name', 'table'), 'table')))
      .flatMap((t) =>
        Object.values(asRecord(field(t, 'checkConstraints', 'table'), 'checks')).map((c) => ({
          name: asString(field(c, 'name', 'check'), 'check'),
          value: asString(field(c, 'value', 'check'), 'check'),
        })),
      )
      .filter((c) => !/^"[a-z_]+"\."[a-z_]+" in \(/u.test(c.value))
      .map((c) => c.name);
    expect(identityTables.size).toBe(14);
    for (const table of identityTables) tableShape(table);
    expect([...modelled].sort()).toEqual([...snapshotChecks].sort());
  });
});

describe('concept-identity: relationships and keys', () => {
  const relationships = loadVectors(FAMILY, 'relationships.json');
  it.each(relationships.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const table = tableShape(asString(field(vector.input, 'table', vector.id), vector.id));
    const name = asString(field(vector.input, 'foreignKey', vector.id), vector.id);
    const fk = table.foreignKeys.get(name);
    if (fk === undefined) throw new Error(`${vector.id}: no such foreign key in Drizzle`);
    const expected = asRecord(vector.expected, vector.id);
    expect(fk.columns).toEqual(asStrings(expected['columns'], vector.id));
    expect(fk.refTable).toBe(asString(expected['refTable'], vector.id));
    expect(fk.refColumns).toEqual(asStrings(expected['refColumns'], vector.id));
    expect(fk.onDelete).toBe(asString(expected['onDelete'], vector.id));
    const parent = fk.columns.every((c) => table.notNull.has(c)) ? 'exactly-one' : 'at-most-one';
    expect(parent).toBe(asString(expected['parent'], vector.id));
    const childIsKey =
      sameSet(fk.columns, table.primaryKey) ||
      [...table.uniques.values()].some((cols) => sameSet(fk.columns, cols));
    expect(childIsKey ? 'at-most-one' : 'many').toBe(asString(expected['child'], vector.id));
  });

  it('the model lists every foreign key of the fourteen tables', () => {
    const live = clusterTables.flatMap((t) => [...tableShape(t).foreignKeys.keys()]);
    const modelled = relationships.map((v) => asString(field(v.input, 'foreignKey', v.id), v.id));
    expect(modelled.sort()).toEqual(live.sort());
  });

  const uniques = loadVectors(FAMILY, 'uniques.json');
  it('the model lists every total unique key of the fourteen tables', () => {
    const live = clusterTables.flatMap((t) => [...tableShape(t).uniques.keys()]);
    const modelled = uniques.map((v) => asString(field(v.input, 'unique', v.id), v.id));
    expect(modelled.sort()).toEqual(live.sort());
  });

  it.each(uniques.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const table = tableShape(asString(field(vector.input, 'table', vector.id), vector.id));
    const name = asString(field(vector.input, 'unique', vector.id), vector.id);
    expect(table.uniques.get(name)).toEqual(
      asStrings(field(vector.expected, 'columns', vector.id), vector.id),
    );
  });
});

describe('concept-identity: authenticated principals', () => {
  interface ExpectedPrincipal {
    readonly principalId: string;
    readonly kind: string;
    readonly workspaceId: string;
    readonly label: string;
    readonly userId: string | null;
    readonly actor: string;
    readonly role: string;
    readonly via: string;
    readonly apiKeyId: string | null;
    readonly scope: TokenScope | null;
    readonly ownerPrincipalId: string;
  }

  function expectedPrincipal(value: unknown, what: string): ExpectedPrincipal {
    const r = asRecord(value, what);
    return {
      principalId: asString(r['principalId'], what),
      kind: asString(r['kind'], what),
      workspaceId: asString(r['workspaceId'], what),
      label: asString(r['label'], what),
      userId: asNullableString(r['userId'], what),
      actor: asString(r['actor'], what),
      role: asString(r['role'], what),
      via: asString(r['via'], what),
      apiKeyId: asNullableString(r['apiKeyId'], what),
      scope: r['scope'] === null ? null : asScope(r['scope'], what),
      ownerPrincipalId: asString(r['ownerPrincipalId'], what),
    };
  }

  function fromRecord(value: unknown, what: string): Principal {
    const r = asRecord(value, what);
    return Principal.fromDirectoryRecord({
      principalId: asString(r['principalId'], what),
      kind: asServerKind(r['kind'], what),
      workspaceId: asString(r['workspaceId'], what),
      role: asRole(r['role'], what),
      label: asString(r['label'], what),
      userId: asNullableString(r['userId'], what),
      apiKeyId: asNullableString(r['apiKeyId'], what),
      actsForPrincipalId: asNullableString(r['actsForPrincipalId'], what),
    });
  }

  function build(vector: FormalVector): Principal {
    const constructor = asString(field(vector.input, 'constructor', vector.id), vector.id);
    switch (constructor) {
      case 'fromDirectoryRecord':
        return fromRecord(field(vector.input, 'record', vector.id), vector.id);
      case 'fromApiKey': {
        const i = asRecord(field(vector.input, 'identity', vector.id), vector.id);
        return Principal.fromApiKey({
          principalId: asString(i['principalId'], vector.id),
          apiKeyId: asString(i['apiKeyId'], vector.id),
          workspaceId: asString(i['workspaceId'], vector.id),
          role: asRole(i['role'], vector.id),
          label: asString(i['label'], vector.id),
          actsForPrincipalId: asNullableString(i['actsForPrincipalId'], vector.id),
        });
      }
      case 'fromBrowserToken':
        return Principal.fromBrowserToken(
          fromRecord(field(vector.input, 'record', vector.id), vector.id),
          asScope(field(vector.input, 'scope', vector.id), vector.id),
        );
      default:
        throw new Error(`${vector.id}: unknown constructor ${constructor}`);
    }
  }

  const vectors = loadVectors(FAMILY, 'principals.json');
  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const principal = build(vector);
    const expected = asRecord(vector.expected, vector.id);
    const model = expectedPrincipal(expected['principal'], vector.id);
    expect({
      principalId: principal.principalId,
      kind: principal.kind,
      workspaceId: principal.workspaceId,
      label: principal.label,
      userId: principal.userId,
      actor: principal.actor,
      role: principal.role,
      via: principal.via,
      apiKeyId: principal.apiKeyId,
      scope:
        principal.scope === null ? null : { kind: principal.scope.kind, id: principal.scope.id },
      ownerPrincipalId: principal.ownerPrincipalId,
    }).toEqual(model);
    const wellFormed = asBoolean(field(expected['principal'], 'wellFormed', vector.id), vector.id);
    expect(Principal.isPrincipal(principal)).toBe(wellFormed);
    if (expected['me'] !== null) {
      const body = readMe(principal).body;
      expect(body).toEqual(asRecord(expected['me'], vector.id));
      expect(MeResponseSchema.safeParse(body).success).toBe(true);
    }
  });

  const meVectors = loadVectors(FAMILY, 'me.json');
  it.each(meVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const current = asBoolean(field(vector.expected, 'acceptedCurrent', vector.id), vector.id);
    const target = asBoolean(field(vector.expected, 'acceptedTarget', vector.id), vector.id);
    expect(MeResponseSchema.safeParse(vector.input).success).toBe(current);
    if (target) expect(current).toBe(true);
  });
});

describe('concept-identity: hand-built principals', () => {
  // `Principal`'s constructor is private to TypeScript, not at run time: calling it directly builds
  // a real instance (with its `#provenance`) whose fields no public constructor would pair, which
  // is exactly what `isPrincipal`'s structural half exists to refuse.
  function construct(value: unknown, what: string): unknown {
    const r = asRecord(value, what);
    const args: unknown[] = [
      asString(r['principalId'], what),
      asServerKind(r['kind'], what),
      asString(r['workspaceId'], what),
      asString(r['label'], what),
      asString(r['actor'], what),
      asRole(r['role'], what),
      asString(r['via'], what),
      asNullableString(r['userId'], what),
      asNullableString(r['apiKeyId'], what),
      r['scope'] === null ? null : asScope(r['scope'], what),
      asString(r['ownerPrincipalId'], what),
    ];
    const built: unknown = Reflect.construct(Principal, args);
    return built;
  }

  const actors = loadVectors(FAMILY, 'actors.json');
  it('covers every kind, verifier, scope and owner, with both verdicts', () => {
    const verdicts = actors.map((v) => asBoolean(field(v.expected, 'wellFormed', v.id), v.id));
    expect(actors.length).toBe(2 * 3 * 3 * 2 * 2 * 2);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
  it.each(actors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const built = construct(field(vector.input, 'principal', vector.id), vector.id);
    const wellFormed = asBoolean(field(vector.expected, 'wellFormed', vector.id), vector.id);
    expect(built).toBeInstanceOf(Principal);
    expect(Principal.isPrincipal(built)).toBe(wellFormed);
  });
});

describe('concept-identity: the API-key display prefix', () => {
  const display = loadVectors(FAMILY, 'display-prefixes.json');
  it.each(display.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const value = asString(field(vector.input, 'value', vector.id), vector.id);
    expect(API_KEY_DISPLAY_PREFIX_PATTERN.test(value)).toBe(
      asBoolean(field(vector.expected, 'displayShaped', vector.id), vector.id),
    );
    const keyShaped = asBoolean(field(vector.expected, 'keyShaped', vector.id), vector.id);
    const tokenShaped = asBoolean(field(vector.expected, 'tokenShaped', vector.id), vector.id);
    expect(API_KEY_PATTERN.test(value)).toBe(keyShaped);
    expect(parsePresentedKey(value) !== null).toBe(keyShaped);
    expect(BROWSER_TOKEN_PATTERN.test(value)).toBe(tokenShaped);
    expect(parsePresentedBrowserToken(value) !== null).toBe(tokenShaped);
  });
  it('the display prefix is the key prefix and the key-id length', () => {
    expect(API_KEY_DISPLAY_PREFIX_PATTERN.source).toBe(
      `^${API_KEY_PREFIX}[A-Za-z0-9_-]{${String(API_KEY_ID_LENGTH)}}$`,
    );
  });
});

describe('concept-identity: invitation states, token TTL, constants', () => {
  const iso = (ms: unknown, what: string): string => new Date(asNumber(ms, what)).toISOString();
  const isoOrNull = (ms: unknown, what: string): string | null =>
    ms === null ? null : iso(ms, what);

  const invitations = loadVectors(FAMILY, 'invitation-states.json');
  it.each(invitations.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const resource = InvitationResourceSchema.parse({
      id: 'v1',
      email: 'carol@example.com',
      role: 'viewer',
      invitedBy: 'u1',
      expiresAt: iso(input['expiresAt'], vector.id),
      acceptedAt: isoOrNull(input['acceptedAt'], vector.id),
      revokedAt: isoOrNull(input['revokedAt'], vector.id),
      createdAt: iso(input['createdAt'], vector.id),
    });
    expect(invitationStateOf(resource, asNumber(input['now'], vector.id))).toBe(
      asString(field(vector.expected, 'state', vector.id), vector.id),
    );
  });

  const ttls = loadVectors(FAMILY, 'token-ttl.json');
  it.each(ttls.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const parsed = MintTokenRequestSchema.safeParse({
      scope: { kind: 'run', id: '0b6f9a52-6f7e-4d3c-9f0a-7d1c2b3a4e5f' },
      ttlSeconds: field(vector.input, 'ttlSeconds', vector.id),
    });
    expect(parsed.success).toBe(
      asBoolean(field(vector.expected, 'accepted', vector.id), vector.id),
    );
  });

  const constants = loadVectors(FAMILY, 'constants.json');
  const constant = (id: string): Record<string, unknown> => {
    const vector = constants.find((v) => v.id === id);
    if (vector === undefined) throw new Error(`no vector ${id}`);
    return asRecord(vector.expected, id);
  };

  it('WORKSPACE_SLUG_MAX_LENGTH is one more than the longest slug the database admits', () => {
    const expected = constant('constant/workspace-slug-max-length');
    expect(WORKSPACE_SLUG_MAX_LENGTH).toBe(asNumber(expected['value'], 'slug'));
    const longest = asNumber(expected['longestAdmittedSlug'], 'slug');
    const slug = checkRegExp(snapshotCheck('workspaces', 'workspaces_slug_format'));
    expect(slug.test('a'.repeat(longest))).toBe(true);
    expect(slug.test('a'.repeat(WORKSPACE_SLUG_MAX_LENGTH))).toBe(false);
  });

  // Every constant the model cites, against the contracts export and, where the server keeps its
  // own copy, against that too.
  const exported: Readonly<Record<string, readonly (string | number)[]>> = {
    API_KEY_PREFIX: [API_KEY_PREFIX, SERVER_API_KEY_PREFIX],
    API_KEY_ID_LENGTH: [API_KEY_ID_LENGTH, SERVER_KEY_ID_LENGTH],
    API_KEY_SECRET_LENGTH: [API_KEY_SECRET_LENGTH, SERVER_KEY_SECRET_LENGTH],
    API_KEY_NAME_MAX_LENGTH: [API_KEY_NAME_MAX_LENGTH],
    BROWSER_TOKEN_PREFIX: [BROWSER_TOKEN_PREFIX, SERVER_BROWSER_TOKEN_PREFIX],
    BROWSER_TOKEN_ID_LENGTH: [BROWSER_TOKEN_ID_LENGTH, SERVER_BROWSER_TOKEN_ID_LENGTH],
    BROWSER_TOKEN_SECRET_LENGTH: [BROWSER_TOKEN_SECRET_LENGTH, SERVER_BROWSER_TOKEN_SECRET_LENGTH],
    INVITATION_TOKEN_MAX_LENGTH: [INVITATION_TOKEN_MAX_LENGTH],
    USER_EMAIL_MAX_LENGTH: [USER_EMAIL_MAX_LENGTH],
    USER_NAME_MAX_LENGTH: [USER_NAME_MAX_LENGTH],
    WORKSPACE_NAME_MAX_LENGTH: [WORKSPACE_NAME_MAX_LENGTH],
    WORKSPACE_SLUG_MAX_LENGTH: [WORKSPACE_SLUG_MAX_LENGTH],
    BROWSER_TOKEN_DEFAULT_TTL_SECONDS: [BROWSER_TOKEN_DEFAULT_TTL_SECONDS],
  };
  const constantVectors = constants.filter((v) => v.id.startsWith('constant/'));
  it('every exported constant has a vector', () => {
    const named = constantVectors.map((v) => asString(field(v.input, 'constant', v.id), v.id));
    expect([...named].sort()).toEqual(Object.keys(exported).sort());
  });
  it.each(constantVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const name = asString(field(vector.input, 'constant', vector.id), vector.id);
    const values = exported[name];
    if (values === undefined) throw new Error(`${vector.id}: no export ${name}`);
    const expected = field(vector.expected, 'value', vector.id);
    for (const value of values) expect(value).toBe(expected);
  });

  it('the default TTL is the model constant', () => {
    expect(BROWSER_TOKEN_DEFAULT_TTL_SECONDS).toBe(
      asNumber(constant('constant/browser-token-default-ttl')['value'], 'ttl'),
    );
  });

  it('the API-key and invitation resources have exactly the model fields and no credential', () => {
    const apiKey = constant('resource-fields/api-key');
    expect(Object.keys(ApiKeyResourceSchema.unwrap().shape)).toEqual(
      asStrings(apiKey['fields'], 'k'),
    );
    const invitation = constant('resource-fields/invitation');
    expect(Object.keys(InvitationResourceSchema.shape)).toEqual(
      asStrings(invitation['fields'], 'i'),
    );
    const key = {
      id: 'k1',
      name: 'CI',
      role: 'builder',
      keyPrefix: 'ak_live_AAAAAAAAAAAAAAAAAAAAAA',
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: '2026-09-23T00:00:00.000Z',
    };
    expect(ApiKeyResourceSchema.safeParse(key).success).toBe(true);
    for (const credential of asStrings(apiKey['credentials'], 'k')) {
      expect(ApiKeyResourceSchema.safeParse({ ...key, [credential]: 'x' }).success).toBe(false);
    }
    const row = {
      id: 'v1',
      email: 'carol@example.com',
      role: 'viewer',
      invitedBy: null,
      expiresAt: '2026-09-30T00:00:00.000Z',
      acceptedAt: null,
      revokedAt: null,
      createdAt: '2026-09-23T00:00:00.000Z',
    };
    expect(InvitationResourceSchema.safeParse(row).success).toBe(true);
    for (const credential of asStrings(invitation['credentials'], 'i')) {
      expect(InvitationResourceSchema.safeParse({ ...row, [credential]: 'x' }).success).toBe(false);
    }
  });
});

describe('concept-identity: bearer grammars', () => {
  const bearers = loadVectors(FAMILY, 'bearers.json');
  it.each(bearers.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const credential = asString(field(vector.input, 'credential', vector.id), vector.id);
    const bearer = asString(field(vector.input, 'bearer', vector.id), vector.id);
    const shaped = asBoolean(field(vector.expected, 'shaped', vector.id), vector.id);
    const otherShaped = asBoolean(field(vector.expected, 'otherShaped', vector.id), vector.id);
    const asKey = API_KEY_PATTERN.test(bearer);
    const asToken = BROWSER_TOKEN_PATTERN.test(bearer);
    expect(parsePresentedKey(bearer) !== null).toBe(asKey);
    expect(parsePresentedBrowserToken(bearer) !== null).toBe(asToken);
    if (credential === 'api-key') {
      expect([asKey, asToken]).toEqual([shaped, otherShaped]);
    } else {
      expect(credential).toBe('browser-token');
      expect([asToken, asKey]).toEqual([shaped, otherShaped]);
    }
  });
});
