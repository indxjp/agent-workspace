/**
 * Differential conformance for the `concept-catalog` family: the Lean model of the catalog cluster
 * (formal/AgentWorkspace/Concepts/{Agent,Skill,File,Connector,Grant}.lean and
 * formal/AgentWorkspace/Er/Current/Catalog.lean) replayed against the REAL code:
 *
 *   - the eighteen tables against the live Drizzle table objects (read with Drizzle's own
 *     `getTableConfig`, through the declared test escape `@agent-workspace/core/db/unscoped`),
 *     the SQL of every modelled check against the model's snapshot (`MODEL_SNAPSHOT`);
 *   - the concept enumerations against the schema constants and the contracts constants, and the
 *     access modes against `AgentResourceAssignmentsSchema` itself;
 *   - the wire field lists against the Zod resource schemas;
 *   - the HTTP length bounds against the contract constants;
 *   - the skill-name grammar against `SKILL_NAME_PATTERN` and the `skills_name_shape` regex;
 *   - the file-path grammar against the `files_path_shape` and `files_path_no_dot_segments`
 *     regexes as the snapshot renders them;
 *   - the grants body against `AgentGrantsSchema`, and the assignment body against
 *     `AgentResourceAssignmentsSchema` (non-empty ids, the closed access set, no unknown key,
 *     duplicates admitted);
 *   - the `replace` outcomes (`replace.json`) against the parts that need no database: every
 *     request is a body the schema accepts, every outcome is a `ReplaceAgentResourcesOutcome`,
 *     every `updated` answer is an `AgentResourceAssignmentsResponseSchema` body, lists each id in
 *     ascending order and holds exactly the requested ids. Replaying the outcome itself against
 *     `AgentResourceRepository.replace` needs PostgreSQL (see the unit report's gaps).
 *
 * `parseCreateConnectorBody` is application code and replays in
 * `apps/web/formal/concept-catalog.test.ts` (decision D-012).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_MUTABLE_FIELDS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PERMISSION_KEYS,
  AgentGrantsSchema,
  AgentResourceAssignmentsResponseSchema,
  AgentResourceAssignmentsSchema,
  AgentResourceSchema,
} from '@indx-workspace/contracts/agents';
import {
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_KINDS,
  CONNECTOR_NAME_MAX_LENGTH,
  CONNECTOR_TRANSPORTS,
  ConnectorResourceSchema,
} from '@indx-workspace/contracts/connectors';
import { FILE_KINDS, FileResourceSchema } from '@indx-workspace/contracts/files';
import {
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  SkillDetailSchema,
} from '@indx-workspace/contracts/skills';
import type { ReplaceAgentResourcesOutcome } from '@agent-workspace/core/db';
import * as schema from '@agent-workspace/core/db/unscoped';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors, MODEL_SNAPSHOT, type FormalVector } from './vectors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAMILY = 'concept-catalog';
const tableVectors = loadVectors(FAMILY, 'tables.json');
const enumVectors = loadVectors(FAMILY, 'enums.json');
const constantVectors = loadVectors(FAMILY, 'constants.json');
const skillNameVectors = loadVectors(FAMILY, 'skill-names.json');
const filePathVectors = loadVectors(FAMILY, 'file-paths.json');
const grantBodyVectors = loadVectors(FAMILY, 'grants-body.json');
const assignmentBodyVectors = loadVectors(FAMILY, 'assignments-body.json');
const replaceVectors = loadVectors(FAMILY, 'replace.json');

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
// The live Drizzle tables.

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
  readonly kind: string;
}
interface TableShape {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnShape[];
  readonly foreignKeys: readonly ForeignKeyShape[];
  readonly uniques: readonly UniqueShape[];
  readonly checks: readonly string[];
}

const pgCore: unknown = pgCoreModule;
const TABLE_NAME = Symbol.for('drizzle:Name');
const INLINE_FOREIGN_KEYS = Symbol.for('drizzle:PgInlineForeignKeys');

const byName = <T extends { readonly name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

function columnNames(columns: unknown, what: string): string[] {
  return asArray(columns, what).map((c) => asString(field(c, 'name', what), what));
}

function readDrizzleTable(table: unknown): TableShape {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const name = asString(field(config, 'name', 'table config'), 'table name');
  const inline = new Set(
    asArray(symbolField(table, INLINE_FOREIGN_KEYS), `${name}: inline keys`).map((fk) =>
      asString(call(fk, 'getName', name), name),
    ),
  );
  const columnObjects = asArray(field(config, 'columns', name), `${name}.columns`);
  const composite = asArray(field(config, 'primaryKeys', name), `${name}.primaryKeys`);
  const primaryKey =
    composite.length > 0
      ? columnNames(field(composite[0], 'columns', name), `${name} pk`)
      : columnObjects
          .filter((c) => field(c, 'primary', name) === true)
          .map((c) => asString(field(c, 'name', name), name));
  const foreignKeys = asArray(field(config, 'foreignKeys', name), `${name}.foreignKeys`).map(
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
  const constraints = asArray(field(config, 'uniqueConstraints', name), name).map((u) => ({
    name: asString(call(u, 'getName', name), name),
    columns: columnNames(field(u, 'columns', name), name),
    kind: 'constraint',
  }));
  const indexes = asArray(field(config, 'indexes', name), name)
    .map((index) => field(index, 'config', name))
    .filter((indexConfig) => field(indexConfig, 'unique', name) === true)
    .map((indexConfig) => ({
      name: asString(field(indexConfig, 'name', name), name),
      columns: columnNames(field(indexConfig, 'columns', name), name),
      kind: 'index',
    }));
  return {
    name,
    primaryKey,
    columns: columnObjects.map((c) => ({
      name: asString(field(c, 'name', name), name),
      type: asString(call(c, 'getSQLType', name), name),
      notNull: asBoolean(field(c, 'notNull', name), name),
    })),
    foreignKeys: byName(foreignKeys),
    uniques: byName([...constraints, ...indexes]),
    checks: asArray(field(config, 'checks', name), name)
      .map((c) => asString(field(c, 'name', name), name))
      .sort(),
  };
}

const drizzleByExport = new Map<string, TableShape>();
const drizzleByName = new Map<string, TableShape>();
for (const [exportName, value] of Object.entries(schema) as [string, unknown][]) {
  if (symbolField(value, TABLE_NAME) === undefined || typeof value !== 'object') continue;
  const shape = readDrizzleTable(value);
  drizzleByExport.set(exportName, shape);
  drizzleByName.set(shape.name, shape);
}

function drizzleTable(name: string): TableShape {
  const table = drizzleByName.get(name);
  if (table === undefined) throw new Error(`no Drizzle table ${name}`);
  return table;
}

// ---------------------------------------------------------------------------------------------
// The snapshot's check bodies.

const snapshot: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, MODEL_SNAPSHOT), 'utf8'));
const snapshotChecks = new Map<string, string>();
for (const table of Object.values(asRecord(field(snapshot, 'tables', 'snapshot'), 'tables'))) {
  for (const check of Object.values(
    asRecord(field(table, 'checkConstraints', 'table'), 'checks'),
  )) {
    snapshotChecks.set(
      asString(field(check, 'name', 'check'), 'check name'),
      asString(field(check, 'value', 'check'), 'check value'),
    );
  }
}

function snapshotCheck(name: string): string {
  const body = snapshotChecks.get(name);
  if (body === undefined) throw new Error(`the snapshot has no check ${name}`);
  return body;
}

/** The regular expression of a `"t"."c" ~ '…'` or `!~ '…'` check body, as a JavaScript RegExp.
 *  PostgreSQL's `[:cntrl:]` class is spelled out as the C0 controls, DEL and the C1 controls. */
function checkRegex(name: string): RegExp {
  const match = /~ '(.*)'$/u.exec(snapshotCheck(name));
  const source = match?.[1];
  if (source === undefined) throw new Error(`${name} is not a regular-expression check`);
  return new RegExp(source.replaceAll('[:cntrl:]', '\\u0000-\\u001f\\u007f-\\u009f'), 'u');
}

// ---------------------------------------------------------------------------------------------
// Tenancy class, re-derived from the Drizzle shape (the tenancy.test.ts helpers are private).

const GLOBAL_TABLES = new Set(['users', 'user_identities']);

function tenantColumn(table: string): string | null {
  if (table === 'workspaces') return 'id';
  return GLOBAL_TABLES.has(table) ? null : 'workspace_id';
}

function pairs(fk: ForeignKeyShape): [string, string][] {
  return fk.columns.map((c, i) => [c, fk.refColumns[i] ?? '']);
}

function isPaired(table: string, fk: ForeignKeyShape): boolean {
  const child = tenantColumn(table);
  const parent = tenantColumn(fk.refTable);
  return (
    child !== null && parent !== null && pairs(fk).some(([c, p]) => c === child && p === parent)
  );
}

function tenancyClass(table: TableShape, fk: ForeignKeyShape): string {
  if (GLOBAL_TABLES.has(fk.refTable)) {
    return fk.columns.includes('workspace_id') ? 'unpaired' : 'global-reference';
  }
  if (fk.refTable === 'workspaces') {
    return isPaired(table.name, fk) && fk.columns.length === 1 ? 'root-reference' : 'unpaired';
  }
  if (isPaired(table.name, fk)) return 'tenant-paired';
  const [column] = fk.columns;
  const [key] = fk.refColumns;
  const covered =
    fk.columns.length === 1 &&
    column !== undefined &&
    key !== undefined &&
    table.foreignKeys.some(
      (g) =>
        g.refTable === fk.refTable &&
        isPaired(table.name, g) &&
        pairs(g).some(([c, p]) => c === column && p === key),
    );
  return covered ? 'sibling-paired' : 'unpaired';
}

function isExactKey(fk: ForeignKeyShape): boolean {
  const parent = drizzleTable(fk.refTable);
  const same = (cols: readonly string[]): boolean =>
    cols.length === fk.refColumns.length && cols.every((c, i) => c === fk.refColumns[i]);
  return same(parent.primaryKey) || parent.uniques.some((u) => same(u.columns));
}

// ---------------------------------------------------------------------------------------------

describe('concept-catalog: the eighteen tables against the live Drizzle schema', () => {
  const tables = tableVectors.filter((v) => v.id.startsWith('table/'));

  it('covers exactly the eighteen tables of the cluster', () => {
    expect(tables.map((v) => asString(field(v.input, 'table', v.id), v.id)).sort()).toEqual([
      'agent_files',
      'agent_grants',
      'agent_mcp_servers',
      'agent_pointer_moves',
      'agent_skills',
      'agent_storage_grants',
      'agent_version_evaluations',
      'agent_version_pointers',
      'agent_version_storage_grants',
      'agent_versions',
      'agents',
      'file_texts',
      'files',
      'mcp_servers',
      'project_files',
      'project_mcp_servers',
      'skill_revisions',
      'skills',
    ]);
  });

  it.each(tables.map((v) => [v.id, v] as const))('%s', (_id, vector: FormalVector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const tsExport = asString(input['tsExport'], vector.id);
    const live = drizzleByExport.get(tsExport);
    if (live === undefined) throw new Error(`${vector.id}: no Drizzle export ${tsExport}`);
    expect(live.name).toBe(input['table']);
    expect(live.columns).toEqual(expected['columns']);
    expect(live.primaryKey).toEqual(expected['primaryKey']);

    const modelKeys = asArray(expected['foreignKeys'], vector.id).map((k) =>
      asRecord(k, vector.id),
    );
    expect(
      byName(
        modelKeys.map((k) => ({
          name: asString(k['name'], vector.id),
          columns: asStrings(k['columns'], vector.id),
          refTable: asString(k['refTable'], vector.id),
          refColumns: asStrings(k['refColumns'], vector.id),
          onDelete: asString(k['onDelete'], vector.id),
          inline: asBoolean(k['inline'], vector.id),
        })),
      ),
    ).toEqual(live.foreignKeys);
    for (const k of modelKeys) {
      const fk = live.foreignKeys.find((f) => f.name === k['name']);
      if (fk === undefined) throw new Error(`${vector.id}: missing ${String(k['name'])}`);
      const notNull = fk.columns.every((c) => live.columns.find((col) => col.name === c)?.notNull);
      expect({ name: fk.name, class: tenancyClass(live, fk), mandatory: notNull }).toEqual({
        name: fk.name,
        class: k['class'],
        mandatory: k['mandatory'],
      });
      expect(isExactKey(fk)).toBe(k['exactKey']);
    }

    const modelUniques = asArray(expected['uniques'], vector.id).map((u) => {
      const unique = asRecord(u, vector.id);
      return {
        name: asString(unique['name'], vector.id),
        columns: asStrings(unique['columns'], vector.id),
        kind: asString(unique['kind'], vector.id),
      };
    });
    expect(byName(modelUniques)).toEqual(live.uniques);

    const checks = asArray(expected['checks'], vector.id).map((c) => asRecord(c, vector.id));
    expect(checks.map((c) => asString(c['name'], vector.id)).sort()).toEqual(live.checks);
    for (const check of checks) {
      const name = asString(check['name'], vector.id);
      const values = check['values'];
      if (values !== null) {
        const listed = asStrings(values, name);
        expect(snapshotCheck(name)).toMatch(
          new RegExp(`in \\(${listed.map((v) => `'${v}'`).join(', ')}\\)$`, 'u'),
        );
      } else {
        // Every non-closed-set check of the cluster is modelled, and its semantics are those of
        // exactly this SQL body.
        expect(check['modelled']).toBe(true);
        expect(check['sql']).toBe(snapshotCheck(name));
      }
    }
  });

  it.each(tableVectors.filter((v) => v.id.startsWith('concept-columns/')).map((v) => [v.id, v]))(
    '%s maps every column in order',
    (_id, vector) => {
      const table = drizzleTable(asString(field(vector.input, 'table', vector.id), vector.id));
      expect(table.columns.map((c) => c.name)).toEqual(
        field(vector.expected, 'columns', vector.id),
      );
    },
  );
});

// ---------------------------------------------------------------------------------------------

function enumValues(id: string): readonly (readonly string[])[] {
  switch (id) {
    case 'enum/file-kind':
      return [schema.fileKinds, FILE_KINDS];
    case 'enum/file-access':
      return [schema.fileAccessModes];
    case 'enum/connector-kind':
      return [schema.connectorKinds, CONNECTOR_KINDS];
    case 'enum/transport':
      return [schema.mcpTransports, CONNECTOR_TRANSPORTS];
    case 'enum/auth-type':
      return [schema.mcpAuthTypes, CONNECTOR_AUTH_TYPES];
    case 'enum/remote-transport':
      return [schema.remoteMcpTransports];
    case 'enum/credentialed-auth-type':
      return [schema.credentialedMcpAuthTypes];
    case 'enum/agent-permission-key':
      return [
        AGENT_PERMISSION_KEYS,
        Object.keys(shapeOf(schema.AgentPermissions, 'AgentPermissions')),
      ];
    case 'enum/agent-mutable-field':
      return [AGENT_MUTABLE_FIELDS];
    default:
      throw new Error(`no TypeScript counterpart for ${id}`);
  }
}

/** The keys of a Zod object schema, through any `.readonly()` wrappers. */
function shapeOf(zodSchema: unknown, what: string): Record<string, unknown> {
  let current = zodSchema;
  for (let depth = 0; depth < 4; depth += 1) {
    const shape = field(current, 'shape', what);
    if (typeof shape === 'object' && shape !== null) return asRecord(shape, what);
    current = call(current, 'unwrap', what);
  }
  throw new Error(`${what}: not an object schema`);
}

const wireSchemas: Readonly<Record<string, unknown>> = {
  AgentResourceSchema,
  ConnectorResourceSchema,
  FileResourceSchema,
  SkillDetailSchema,
};

describe('concept-catalog: enumerations and wire fields against the code', () => {
  it.each(enumVectors.filter((v) => v.id.startsWith('enum/')).map((v) => [v.id, v] as const))(
    '%s',
    (id, vector) => {
      const values = asStrings(field(vector.expected, 'values', id), id);
      for (const actual of enumValues(id)) expect([...actual]).toEqual(values);
    },
  );

  it('the file access modes are exactly what AgentResourceAssignmentsSchema admits', () => {
    const vector = enumVectors.find((v) => v.id === 'enum/file-access');
    if (vector === undefined) throw new Error('missing enum/file-access');
    const modes = asStrings(field(vector.expected, 'values', vector.id), vector.id);
    const admits = (access: string): boolean =>
      AgentResourceAssignmentsSchema.safeParse({
        files: [{ fileId: 'f', access }],
        skillIds: [],
        connectorIds: [],
      }).success;
    for (const mode of modes) expect(admits(mode)).toBe(true);
    for (const miss of ['write', 'read_write', 'READ', 'readwrite', '']) {
      expect(admits(miss)).toBe(false);
    }
  });

  it.each(enumVectors.filter((v) => v.id.startsWith('wire/')).map((v) => [v.id, v] as const))(
    '%s lists the schema keys in order; only the declared optional keys accept undefined',
    (id, vector) => {
      const schemaName = asString(field(vector.input, 'schema', id), id);
      const shape = shapeOf(wireSchemas[schemaName], schemaName);
      const fields = asStrings(field(vector.expected, 'fields', id), id);
      const optional = asStrings(field(vector.expected, 'optional', id), id);
      expect(Object.keys(shape)).toEqual(fields);
      expect(optional.filter((key) => !fields.includes(key))).toEqual([]);
      for (const [key, member] of Object.entries(shape)) {
        const parsed = call(member, 'safeParse', `${schemaName}.${key}`, undefined);
        expect({ key, acceptsUndefined: field(parsed, 'success', key) }).toEqual({
          key,
          acceptsUndefined: optional.includes(key),
        });
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------

const contractConstants: Readonly<Record<string, number>> = {
  AGENT_NAME_MAX_LENGTH,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  CONNECTOR_NAME_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
};

describe('concept-catalog: the length bounds against the contract constants', () => {
  it('covers every modelled constant', () => {
    expect(constantVectors.map((v) => v.id).sort()).toEqual(
      Object.keys(contractConstants)
        .map((name) => `constant/${name}`)
        .sort(),
    );
  });
  it.each(constantVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const name = asString(field(vector.input, 'constant', id), id);
    expect(contractConstants[name]).toBe(field(vector.expected, 'value', id));
  });
});

describe('concept-catalog: the skill-name grammar', () => {
  const shape = checkRegex('skills_name_shape');
  it.each(skillNameVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const name = asString(field(vector.input, 'name', id), id);
    const valid = field(vector.expected, 'valid', id);
    expect(SKILL_NAME_PATTERN.test(name)).toBe(valid);
    expect(shape.test(name)).toBe(valid);
  });
});

describe('concept-catalog: the file-path grammar', () => {
  const shape = checkRegex('files_path_shape');
  const dotSegment = checkRegex('files_path_no_dot_segments');
  it('the no-dot check is a negated match', () => {
    expect(snapshotCheck('files_path_no_dot_segments')).toContain(' !~ ');
    expect(snapshotCheck('files_path_shape')).toContain(' ~ ');
  });
  it.each(filePathVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const p = asString(field(vector.input, 'path', id), id);
    expect(shape.test(p)).toBe(field(vector.expected, 'shape', id));
    expect(!dotSegment.test(p)).toBe(field(vector.expected, 'noDotSegments', id));
  });
});

describe('concept-catalog: the grants body', () => {
  it.each(grantBodyVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const parsed = AgentGrantsSchema.safeParse(vector.input);
    const expected = asRecord(vector.expected, id);
    expect(parsed.success).toBe(expected['valid']);
    if (parsed.success) expect(parsed.data.principalIds).toEqual(expected['principalIds']);
  });
});

describe('concept-catalog: the assignment body', () => {
  it('replays both accepted and refused bodies', () => {
    const outcomes = assignmentBodyVectors.map((v) => field(v.expected, 'valid', v.id));
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });

  it.each(assignmentBodyVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const parsed = AgentResourceAssignmentsSchema.safeParse(field(vector.input, 'body', id));
    const expected = asRecord(vector.expected, id);
    expect(parsed.success).toBe(expected['valid']);
    if (parsed.success) expect(parsed.data).toEqual(expected['value']);
  });
});

/** The model's outcome as the repository's own union type: an unknown kind fails here. */
function asReplaceOutcome(value: unknown, what: string): ReplaceAgentResourcesOutcome {
  const kind = asString(field(value, 'kind', what), `${what}.kind`);
  switch (kind) {
    case 'updated':
      return {
        kind,
        assignments: AgentResourceAssignmentsSchema.parse(field(value, 'assignments', what)),
      };
    case 'not-found':
      return { kind };
    case 'unknown-file':
    case 'unknown-skill':
    case 'unknown-connector':
      return { kind, id: asString(field(value, 'id', what), `${what}.id`) };
    default:
      throw new Error(`${what}: ${kind} is not a ReplaceAgentResourcesOutcome kind`);
  }
}

function ascending(ids: readonly string[]): boolean {
  return ids.every((id, index) => index === 0 || (ids[index - 1] ?? '') <= id);
}

describe('concept-catalog: replace outcomes (shape and id order)', () => {
  it('replays every outcome kind', () => {
    const kinds = new Set(replaceVectors.map((v) => field(v.expected, 'kind', v.id)));
    expect([...kinds].sort()).toEqual(
      ['not-found', 'unknown-connector', 'unknown-file', 'unknown-skill', 'updated'].sort(),
    );
  });

  it.each(replaceVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const requested = AgentResourceAssignmentsSchema.parse(field(vector.input, 'requested', id));
    const outcome = asReplaceOutcome(vector.expected, id);
    if (outcome.kind !== 'updated') return;
    const { assignments } = AgentResourceAssignmentsResponseSchema.parse({
      assignments: outcome.assignments,
    });
    const fileIds = assignments.files.map((entry) => entry.fileId);
    expect(ascending(fileIds)).toBe(true);
    expect(ascending(assignments.skillIds)).toBe(true);
    expect(ascending(assignments.connectorIds)).toBe(true);
    expect([...fileIds].sort()).toEqual(requested.files.map((entry) => entry.fileId).sort());
    expect(assignments.skillIds).toEqual([...new Set(requested.skillIds)].sort());
    expect(assignments.connectorIds).toEqual([...new Set(requested.connectorIds)].sort());
  });
});
