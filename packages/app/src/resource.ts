/**
 * `defineResource`: one resource, the single source its table, routes, agent tools and pages are
 * derived from (F-10, issue #1501).
 */
import { MEMBERSHIP_ROLES, type MembershipRoleName } from '@indx-workspace/contracts/team';
import { DefinitionError, issuesFromZod, type DefinitionIssue } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { brand, hasBrand, type AppBranded } from './brand.js';
import type { AnyField, FieldType } from './fields/types.js';
import { IDENTIFIER_MAX, SNAKE_CASE, SnakeCaseNameSchema } from './names.js';

/**
 * The columns every resource table has, which a field may not be named: the record id, the
 * tenant, the two timestamps and the two people who created and last changed the record.
 */
export const RESERVED_FIELD_NAMES = [
  'id',
  'workspace_id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
] as const;

/** The most fields one resource may have. */
const RESOURCE_MAX_FIELDS = 100;

/**
 * Who may do something to a record: every member (`'member'`), a role or higher
 * (`'role:admin'`; roles are monotonic, ADR-0152), or the person in the named `person()` field.
 * Several rules in an array mean any one of them.
 */
export type AccessRule = 'member' | `role:${MembershipRoleName}` | (string & {});

/** One rule or a list of alternatives. */
export type AccessRules = AccessRule | readonly AccessRule[];

/** The four operations a resource's `access` answers for. */
export type AccessOperation = 'read' | 'create' | 'update' | 'delete';

/** A resource's fields by name. */
export type FieldMap = Readonly<Record<string, AnyField>>;

/** What {@link defineResource} accepts. */
export interface ResourceInput<F extends FieldMap = FieldMap> {
  /** snake_case, 1–63 characters; the record name (`ticket`). */
  readonly name: string;
  /** The table and route name; `name + 's'` when not given (`tickets`). */
  readonly plural?: string;
  /** 1–100 fields, snake_case names, none of {@link RESERVED_FIELD_NAMES}. */
  readonly fields: F;
  readonly access: Readonly<Record<AccessOperation, AccessRules>>;
  /**
   * What agents acting for a person may do: read, and write the listed fields. They never exceed
   * the person's own `access`. `{ read: false, write: false }` when not given.
   */
  readonly agents?: {
    readonly read: boolean;
    readonly write: readonly (keyof F & string)[] | false;
  };
  /** The `text()` and `richText()` fields full-text search covers. */
  readonly search?: readonly (keyof F & string)[];
  /** Whether writes leave audit rows; `true` when not given. */
  readonly audit?: boolean;
  /** The `enumOf()` field whose values are the columns of the board view. */
  readonly board?: keyof F & string;
}

/** A defined resource's settings, with every default filled in and every rule list an array. */
export interface ResourceDefinition<F extends FieldMap = FieldMap> {
  readonly name: string;
  readonly plural: string;
  readonly fields: F;
  readonly access: Readonly<Record<AccessOperation, readonly AccessRule[]>>;
  readonly agents: {
    readonly read: boolean;
    readonly write: readonly (keyof F & string)[] | false;
  };
  readonly search: readonly (keyof F & string)[];
  readonly audit: boolean;
  readonly board?: keyof F & string;
}

/** What {@link defineResource} returns: the resource, frozen and branded. */
export type DefinedResource<F extends FieldMap = FieldMap> = ResourceDefinition<F> &
  AppBranded<'resource'>;

const ROLE_RULES: readonly string[] = MEMBERSHIP_ROLES.map((role) => `role:${role}`);
const RESERVED: readonly string[] = RESERVED_FIELD_NAMES;

const AccessRuleSchema = z
  .string()
  .refine(
    (rule) =>
      rule === 'member' ||
      ROLE_RULES.includes(rule) ||
      (SNAKE_CASE.test(rule) && rule.length <= IDENTIFIER_MAX),
    {
      message: `an access rule is "member", ${ROLE_RULES.map((rule) => `"${rule}"`).join(', ')} or the name of a person() field`,
    },
  );

const AccessRulesSchema = z.union([AccessRuleSchema, z.array(AccessRuleSchema).min(1).max(16)]);

const FieldNameSchema = SnakeCaseNameSchema.refine((name) => !RESERVED.includes(name), {
  message: `is reserved for a column every resource has (${RESERVED.join(', ')})`,
});

const FieldSchema = z.custom<AnyField>((value) => hasBrand(value, 'field'), {
  message: 'must be made by a field builder such as text() or enumOf(), not written by hand',
});

const ResourceInputSchema = z.strictObject({
  name: SnakeCaseNameSchema,
  plural: SnakeCaseNameSchema.optional(),
  fields: z.record(FieldNameSchema, FieldSchema),
  access: z.strictObject({
    read: AccessRulesSchema,
    create: AccessRulesSchema,
    update: AccessRulesSchema,
    delete: AccessRulesSchema,
  }),
  agents: z
    .strictObject({
      read: z.boolean(),
      write: z.union([z.literal(false), z.array(SnakeCaseNameSchema).max(RESOURCE_MAX_FIELDS)]),
    })
    .optional(),
  search: z.array(SnakeCaseNameSchema).min(1).max(RESOURCE_MAX_FIELDS).optional(),
  audit: z.boolean().optional(),
  board: SnakeCaseNameSchema.optional(),
});

const KNOWN_KEYS = Object.keys(ResourceInputSchema.shape);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The rules of one access operation as written, a single rule counted as a list of one. */
function rulesOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** A raw input's fields, read defensively: the type of each branded field by name. */
function fieldTypesOf(input: Record<string, unknown>): ReadonlyMap<string, FieldType> {
  const fields = input['fields'];
  if (!isRecord(fields)) return new Map();
  return new Map(
    Object.entries(fields).flatMap(([key, field]) =>
      hasBrand(field, 'field') ? [[key, (field as AnyField).type] as const] : [],
    ),
  );
}

/** The checks one field list (`agents.write`, `search`) or name (`board`) needs. */
interface NameCheck {
  readonly path: string;
  readonly names: readonly unknown[];
  readonly allowed?: readonly FieldType[];
  readonly what: string;
  /** The value is one name, not a list, so the path has no index. */
  readonly single?: boolean;
}

function nameIssues(types: ReadonlyMap<string, FieldType>, check: NameCheck): DefinitionIssue[] {
  return check.names.flatMap((name, index): DefinitionIssue[] => {
    // A name the schema already refused as not snake_case is not reported twice.
    if (typeof name !== 'string' || !SNAKE_CASE.test(name)) return [];
    const path = check.single === true ? check.path : `${check.path}.${String(index)}`;
    const type = types.get(name);
    if (type === undefined) {
      return [{ path, message: `names no field of this resource: ${JSON.stringify(name)}` }];
    }
    if (check.allowed !== undefined && !check.allowed.includes(type)) {
      return [{ path, message: `${check.what}, but ${JSON.stringify(name)} is a ${type}() field` }];
    }
    return [];
  });
}

function accessIssues(
  input: Record<string, unknown>,
  types: ReadonlyMap<string, FieldType>,
): DefinitionIssue[] {
  const access = input['access'];
  if (!isRecord(access)) return [];
  return (['read', 'create', 'update', 'delete'] as const).flatMap((operation) => {
    const value = access[operation];
    const rules = rulesOf(value);
    return rules.flatMap((rule, index): DefinitionIssue[] => {
      if (typeof rule !== 'string' || rule === 'member' || ROLE_RULES.includes(rule)) return [];
      if (!SNAKE_CASE.test(rule)) return [];
      const path = Array.isArray(value)
        ? `access.${operation}.${String(index)}`
        : `access.${operation}`;
      const type = types.get(rule);
      if (type === 'person') return [];
      return [
        {
          path,
          message:
            type === undefined
              ? `names no field of this resource: ${JSON.stringify(rule)} (a field rule names a person() field)`
              : `a field rule names a person() field, but ${JSON.stringify(rule)} is a ${type}() field`,
        },
      ];
    });
  });
}

function fieldShapeIssues(
  input: Record<string, unknown>,
  types: ReadonlyMap<string, FieldType>,
): DefinitionIssue[] {
  const fields = input['fields'];
  if (!isRecord(fields)) return [];
  const count = Object.keys(fields).length;
  const issues: DefinitionIssue[] = [];
  if (count === 0) issues.push({ path: 'fields', message: 'a resource needs at least one field' });
  if (count > RESOURCE_MAX_FIELDS) {
    issues.push({
      path: 'fields',
      message: `a resource may have at most ${String(RESOURCE_MAX_FIELDS)} fields`,
    });
  }
  for (const [key, type] of types) {
    if (type !== 'money') continue;
    const companion = `${key}_currency`;
    if (companion.length > IDENTIFIER_MAX) {
      issues.push({
        path: `fields.${key}`,
        message: `a money() field's name may be at most ${String(IDENTIFIER_MAX - 9)} characters, so its "_currency" column fits`,
      });
    }
    if (Object.hasOwn(fields, companion)) {
      issues.push({
        path: `fields.${companion}`,
        message: `is the currency column of the money() field ${JSON.stringify(key)}`,
      });
    }
  }
  return issues;
}

function pluralIssues(input: Record<string, unknown>): DefinitionIssue[] {
  const { name, plural } = input;
  if (plural !== undefined || typeof name !== 'string' || !SNAKE_CASE.test(name)) return [];
  return name.length + 1 > IDENTIFIER_MAX
    ? [
        {
          path: 'plural',
          message: `"${name}s" is longer than 63 characters; give a shorter plural`,
        },
      ]
    : [];
}

/** Every reason a structurally readable input is refused that one key's schema cannot see. */
function crossFieldIssues(input: unknown): DefinitionIssue[] {
  if (!isRecord(input)) return [];
  const types = fieldTypesOf(input);
  const agents = input['agents'];
  const write = isRecord(agents) && Array.isArray(agents['write']) ? agents['write'] : [];
  const search = Array.isArray(input['search']) ? input['search'] : [];
  const board = input['board'];
  return [
    ...pluralIssues(input),
    ...fieldShapeIssues(input, types),
    ...accessIssues(input, types),
    ...nameIssues(types, { path: 'agents.write', names: write, what: 'agents.write lists fields' }),
    ...nameIssues(types, {
      path: 'search',
      names: search,
      allowed: ['text', 'richText'],
      what: 'search covers text() and richText() fields',
    }),
    ...(typeof board === 'string'
      ? nameIssues(types, {
          path: 'board',
          names: [board],
          single: true,
          allowed: ['enumOf'],
          what: 'a board groups by an enumOf() field',
        })
      : []),
  ];
}

/**
 * Defines one resource of a portal app: its fields, who may read and change its records, what
 * agents may touch, and what search and the board cover.
 *
 * Every mistake is reported at once: the shape (an unknown key also names the key it is closest
 * to), a field not made by a builder, an access rule naming a field that is not a `person()`,
 * `agents.write` or `search` naming a missing (or, for search, non-text) field, and `board`
 * naming a field that is not an `enumOf()`.
 *
 * @throws {DefinitionError} with every reason the input was refused.
 */
export function defineResource<const F extends FieldMap>(
  input: ResourceInput<F>,
): DefinedResource<F> {
  const result = ResourceInputSchema.safeParse(input);
  const issues = [
    ...(result.success ? [] : issuesFromZod(result.error, undefined, KNOWN_KEYS)),
    ...crossFieldIssues(input),
  ];
  if (!result.success || issues.length > 0) {
    throw new DefinitionError('defineResource()', issues);
  }
  const data = result.data;
  const access = Object.freeze(
    Object.fromEntries(
      (['read', 'create', 'update', 'delete'] as const).map((operation) => [
        operation,
        Object.freeze([...rulesOf(data.access[operation])]),
      ]),
    ),
  ) as ResourceDefinition<F>['access'];
  const write = data.agents?.write ?? false;
  const definition: ResourceDefinition<F> = {
    name: data.name,
    plural: data.plural ?? `${data.name}s`,
    fields: Object.freeze({ ...input.fields }),
    access,
    agents: Object.freeze({
      read: data.agents?.read ?? false,
      write: write === false ? false : (Object.freeze([...write]) as readonly (keyof F & string)[]),
    }),
    search: Object.freeze([...(data.search ?? [])]),
    audit: data.audit ?? true,
    ...(data.board === undefined ? {} : { board: data.board }),
  };
  return brand(definition, 'resource');
}

/** Whether `value` was made by {@link defineResource}, in this copy of the app kit or another. */
export function isDefinedResource(value: unknown): value is DefinedResource {
  return hasBrand(value, 'resource');
}
