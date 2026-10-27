/**
 * Differential conformance for the `concept-work` family, package side: the Lean work cluster
 * (formal/AgentWorkspace/Concepts/{Project,Session,Run,RunEvent,Usage}.lean and
 * Er/Current/Work.lean) replayed against the REAL schema, contracts and core package.
 *
 *   - `enums.json`: every enumeration of the cluster is, member for member and in order, the
 *     contract's `as const` array and the schema's array, and the Zod resource schemas accept
 *     exactly its members.
 *   - `foreign-keys.json`: every foreign key of the twelve work tables, read from the live Drizzle
 *     table objects: columns, target, the cardinality its column nullability implies, and whether
 *     its target carries a tenant.
 *   - `checks.json`: the checks that are not closed sets, table by table, and their exact SQL as
 *     the model's snapshot (`MODEL_SNAPSHOT`) renders it.
 *   - `check-rows.json`: row verdicts of `runs_ended_at_iff_terminal` and
 *     `audit_events_subject_id_shape` against `isStoppedRunStatus` / `stoppedRunStatuses` and
 *     `isUuid`.
 *   - `transcript-keys.json`: `PROJECT_KEY_PATTERN`, `validateTenantSessionScope` and the
 *     transcript subpath grammar (`TranscriptSubkeysResponseSchema`).
 *   - `event-names.json`: `EVENT_NAME_PATTERN` on its edges and on every listed frame name.
 *   - `owner-fields.json`: which resource schemas carry `ownerPrincipalId`.
 *
 * The application side (the run store, `renderRun`, session launch) is
 * `apps/web/formal/concept-work.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isUuid } from '@indx-workspace/contracts';
import { AUDIT_ACTIONS, AuditEventSchema } from '@indx-workspace/contracts/observability';
import {
  PROJECT_LIST_FILTERS,
  PROJECT_VISIBILITIES,
  ProjectResourceSchema,
} from '@indx-workspace/contracts/projects';
import {
  ACCOUNTING_STATES,
  isStoppedRunStatus,
  isTerminalRunStatus,
  MODEL_PROVIDERS,
  RUN_STATUSES,
  RunResourceSchema,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from '@indx-workspace/contracts/runs';
import { EVENT_NAME_PATTERN } from '@indx-workspace/contracts/run-events';
import {
  PROJECT_KEY_PATTERN,
  SESSION_STATUSES,
  SessionResourceSchema,
  TranscriptSubkeysResponseSchema,
} from '@indx-workspace/contracts/sessions';
import { validateTenantSessionScope } from '@agent-workspace/run-protocol';
import * as schema from '@agent-workspace/core/db/unscoped';
import * as drizzleModule from 'drizzle-orm';
import * as pgCoreModule from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors, MODEL_SNAPSHOT } from './vectors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const enumVectors = loadVectors('concept-work', 'enums.json');
const foreignKeyVectors = loadVectors('concept-work', 'foreign-keys.json');
const checkVectors = loadVectors('concept-work', 'checks.json');
const checkRowVectors = loadVectors('concept-work', 'check-rows.json');
const transcriptKeyVectors = loadVectors('concept-work', 'transcript-keys.json');
const ownerFieldVectors = loadVectors('concept-work', 'owner-fields.json');
const eventNameVectors = loadVectors('concept-work', 'event-names.json');

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

function symbolField(value: unknown, key: symbol): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key) as unknown;
}

// ---------------------------------------------------------------------------------------------
// The live Drizzle tables and the drizzle-kit snapshot.

const pgCore: unknown = pgCoreModule;
const drizzle: unknown = drizzleModule;
const PgTable = field(pgCore, 'PgTable', 'drizzle-orm/pg-core');
const TABLE_NAME = Symbol.for('drizzle:Name');

interface ForeignKeyShape {
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
}
interface TableShape {
  readonly columns: ReadonlyMap<string, boolean>;
  readonly foreignKeys: ReadonlyMap<string, ForeignKeyShape>;
  readonly checks: readonly string[];
}

function columnNames(columns: unknown, what: string): string[] {
  return asArray(columns, what).map((c) => asString(field(c, 'name', what), what));
}

function readTable(table: unknown): [string, TableShape] {
  const config = call(pgCore, 'getTableConfig', 'drizzle-orm/pg-core', table);
  const name = asString(field(config, 'name', 'table config'), 'table name');
  const columns = new Map<string, boolean>(
    asArray(field(config, 'columns', name), `${name}.columns`).map((c) => [
      asString(field(c, 'name', name), name),
      asBoolean(field(c, 'notNull', name), name),
    ]),
  );
  const foreignKeys = new Map<string, ForeignKeyShape>(
    asArray(field(config, 'foreignKeys', name), `${name}.foreignKeys`).map((fk) => {
      const fkName = asString(call(fk, 'getName', name), `${name} fk name`);
      const reference = call(fk, 'reference', fkName);
      return [
        fkName,
        {
          columns: columnNames(field(reference, 'columns', fkName), fkName),
          refTable: asString(
            symbolField(field(reference, 'foreignTable', fkName), TABLE_NAME),
            `${fkName} target`,
          ),
          refColumns: columnNames(field(reference, 'foreignColumns', fkName), fkName),
        },
      ];
    }),
  );
  const checks = asArray(field(config, 'checks', name), `${name}.checks`).map((c) =>
    asString(field(c, 'name', name), `${name} check`),
  );
  return [name, { columns, foreignKeys, checks }];
}

const tables = new Map<string, TableShape>();
for (const value of Object.values(schema) as unknown[]) {
  if (call(drizzle, 'is', 'drizzle-orm', value, PgTable) !== true) continue;
  const [name, shape] = readTable(value);
  tables.set(name, shape);
}

function tableShape(name: string): TableShape {
  const shape = tables.get(name);
  if (shape === undefined) throw new Error(`the schema has no table ${name}`);
  return shape;
}

const snapshot: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, MODEL_SNAPSHOT), 'utf8'));
const snapshotChecks = new Map<string, string>();
for (const raw of Object.values(asRecord(field(snapshot, 'tables', 'snapshot'), 'tables'))) {
  const constraints = asRecord(field(raw, 'checkConstraints', 'snapshot table'), 'checks');
  for (const check of Object.values(constraints)) {
    snapshotChecks.set(
      asString(field(check, 'name', 'check'), 'check name'),
      asString(field(check, 'value', 'check'), 'check value'),
    );
  }
}

/** A closed-set check body, as `oneOf` renders it (`"t"."c" in ('a', …)`). */
const ONE_OF =
  /^(?:"[a-z_]+"\."[a-z_]+" is null or )?"[a-z_]+"\."[a-z_]+" in \((?:'[^']*'(?:, )?)+\)$/u;

// ---------------------------------------------------------------------------------------------
// Enumerations.

interface EnumSources {
  readonly arrays: readonly (readonly string[])[];
  readonly accepts: (value: string) => boolean;
}

const runShape = RunResourceSchema.unwrap().shape;
const ENUMS: Readonly<Record<string, EnumSources>> = {
  'project-visibility': {
    arrays: [PROJECT_VISIBILITIES, schema.projectVisibilities],
    accepts: (v) => ProjectResourceSchema.shape.visibility.safeParse(v).success,
  },
  'project-list-filter': {
    arrays: [PROJECT_LIST_FILTERS],
    accepts: (v) => (PROJECT_LIST_FILTERS as readonly string[]).includes(v),
  },
  'session-status': {
    arrays: [SESSION_STATUSES, schema.sessionStatuses],
    accepts: (v) => SessionResourceSchema.unwrap().shape.status.safeParse(v).success,
  },
  'model-provider': {
    arrays: [MODEL_PROVIDERS, schema.modelProviders],
    accepts: (v) => runShape.provider.unwrap().safeParse(v).success,
  },
  'accounting-state': {
    arrays: [ACCOUNTING_STATES, schema.accountingStates],
    accepts: (v) => runShape.accountingState.safeParse(v).success,
  },
  'audit-action': {
    arrays: [AUDIT_ACTIONS, schema.auditActions],
    accepts: (v) => AuditEventSchema.unwrap().shape.action.safeParse(v).success,
  },
  'terminal-run-status': {
    arrays: [TERMINAL_RUN_STATUSES, schema.terminalRunStatuses],
    accepts: (v) => RUN_STATUSES.some((s) => s === v && isTerminalRunStatus(s)),
  },
};

function enumSources(name: string): EnumSources {
  const sources = ENUMS[name];
  if (sources === undefined) throw new Error(`no TypeScript sources for enum ${name}`);
  return sources;
}

describe('work enumerations', () => {
  it.each(enumVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const sources = enumSources(asString(input['enum'], vector.id));
    if ('members' in expected) {
      const members = asStrings(expected['members'], vector.id);
      for (const array of sources.arrays) expect([...array]).toEqual(members);
      for (const member of members) expect(sources.accepts(member)).toBe(true);
    } else {
      const value = asString(input['value'], vector.id);
      expect(sources.accepts(value)).toBe(asBoolean(expected['valid'], vector.id));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Foreign keys.

function tenantCarrying(table: string): boolean {
  return table === 'workspaces' || tableShape(table).columns.has('workspace_id');
}

describe('work foreign keys', () => {
  it.each(foreignKeyVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    if (!('table' in input)) {
      const names = asStrings(expected['tables'], vector.id);
      const count = names.reduce((sum, name) => sum + tableShape(name).foreignKeys.size, 0);
      expect(count).toBe(asNumber(expected['count'], vector.id));
      return;
    }
    const table = tableShape(asString(input['table'], vector.id));
    const fk = table.foreignKeys.get(asString(input['name'], vector.id));
    if (fk === undefined) throw new Error(`${vector.id}: the schema has no such foreign key`);
    expect([...fk.columns]).toEqual(asStrings(expected['columns'], vector.id));
    expect(fk.refTable).toBe(asString(expected['refTable'], vector.id));
    expect([...fk.refColumns]).toEqual(asStrings(expected['refColumns'], vector.id));
    const required = fk.columns.every((column) => table.columns.get(column) === true);
    expect(required ? 'exactly-one' : 'at-most-one').toBe(expected['cardinality']);
    expect(tenantCarrying(fk.refTable)).toBe(expected['tenantPreserving']);
  });
});

// ---------------------------------------------------------------------------------------------
// Checks.

describe('work checks', () => {
  it.each(checkVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    if ('table' in input) {
      const table = tableShape(asString(input['table'], vector.id));
      const other = table.checks.filter((name) => {
        const body = snapshotChecks.get(name);
        if (body === undefined) throw new Error(`${vector.id}: ${name} is not in the snapshot`);
        return !ONE_OF.test(body);
      });
      expect([...other].sort()).toEqual(asStrings(expected['otherChecks'], vector.id).sort());
    } else {
      const name = asString(input['name'], vector.id);
      expect(snapshotChecks.get(name)).toBe(asString(expected['sql'], vector.id));
    }
  });
});

function asRunStatus(value: unknown, what: string): RunStatus {
  const status = RUN_STATUSES.find((s) => s === value);
  if (status === undefined) throw new Error(`${what}: not a run status`);
  return status;
}

describe('work check verdicts', () => {
  it.each(checkRowVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const holds = asBoolean(asRecord(vector.expected, vector.id)['holds'], vector.id);
    const check = asString(input['check'], vector.id);
    if (check === 'runs_ended_at_iff_terminal') {
      const status = asRunStatus(input['status'], vector.id);
      const ended = asBoolean(input['endedAt'], vector.id);
      expect(isStoppedRunStatus(status) === ended).toBe(holds);
      expect((schema.stoppedRunStatuses as readonly string[]).includes(status) === ended).toBe(
        holds,
      );
    } else {
      const subjectId = asNullableString(input['subjectId'], vector.id);
      expect(subjectId === null || isUuid(subjectId)).toBe(holds);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Transcript keys and the tenant session scope.

const WORKSPACE_KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('transcript keys', () => {
  it.each(transcriptKeyVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    if ('projectKey' in input) {
      const key = asString(input['projectKey'], vector.id);
      const pattern = asBoolean(expected['pattern'], vector.id);
      const scopeOk = asBoolean(expected['scopeOk'], vector.id);
      expect(PROJECT_KEY_PATTERN.test(key)).toBe(pattern);
      expect(isUuid(key)).toBe(expected['uuid']);
      expect(validateTenantSessionScope({ projectKey: key, configDir: '/var/lib/aw' }).ok).toBe(
        scopeOk,
      );
      // The device-name refusal is private to schemas.ts; it is observable as the one reason a
      // key that passes the pattern is still refused.
      if (pattern) expect(scopeOk).toBe(!asBoolean(expected['device'], vector.id));
    } else if ('configDir' in input) {
      const configDir = asString(input['configDir'], vector.id);
      expect(validateTenantSessionScope({ projectKey: WORKSPACE_KEY, configDir }).ok).toBe(
        expected['scopeOk'],
      );
    } else {
      const subpath = asString(input['subpath'], vector.id);
      expect(TranscriptSubkeysResponseSchema.safeParse({ subkeys: [subpath] }).success).toBe(
        expected['valid'],
      );
      expect(subpath === '').toBe(expected['main']);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Event names.

describe('event names', () => {
  it.each(eventNameVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const name = asString(asRecord(vector.input, vector.id)['name'], vector.id);
    const expected = asRecord(vector.expected, vector.id);
    expect(EVENT_NAME_PATTERN.test(name)).toBe(asBoolean(expected['valid'], vector.id));
    expect([...name].length).toBe(asNumber(expected['length'], vector.id));
  });
});

// ---------------------------------------------------------------------------------------------
// Owner fields on the wire.

const RESOURCE_SHAPES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  ProjectResourceSchema: ProjectResourceSchema.shape,
  SessionResourceSchema: SessionResourceSchema.unwrap().shape,
  RunResourceSchema: runShape,
};

describe('owner fields', () => {
  it.each(ownerFieldVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const shape = RESOURCE_SHAPES[asString(input['schema'], vector.id)];
    if (shape === undefined) throw new Error(`${vector.id}: unknown schema`);
    const fieldName = asString(input['field'], vector.id);
    expect(fieldName in shape).toBe(asRecord(vector.expected, vector.id)['present']);
  });
});
