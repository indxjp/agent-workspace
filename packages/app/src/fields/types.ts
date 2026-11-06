/**
 * The descriptor every field builder returns, and the one constructor they share (issue #1501).
 *
 * A field is plain data: its column, value schema, form control, list cell and agent-tool schema
 * (the field table of the app kit's resource design). `./db`, `./server` and `./react` read the
 * descriptor; this module imports none of Drizzle, Next.js or React, so a resource file loads
 * anywhere.
 */
import { DefinitionError, issuesFromZod } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { brand, type AppBranded } from '../brand.js';

/** The field types, one per builder. `date` and `dateTime` are one row of the table, two types. */
export type FieldType =
  | 'text'
  | 'richText'
  | 'number'
  | 'money'
  | 'bool'
  | 'date'
  | 'dateTime'
  | 'enumOf'
  | 'person'
  | 'ref'
  | 'files'
  | 'tags';

/** The PostgreSQL column type a field is stored as. */
export type ColumnSql =
  'text' | 'jsonb' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'uuid' | 'uuid[]' | 'text[]';

/**
 * How a field is stored. `check`, when present, is a SQL boolean expression in which `{column}`
 * stands for the quoted column name; every literal in it comes from validated options (integers,
 * snake_case enum values, an ISO 4217 code), so it is safe to splice. `companion` is a second
 * column named `<field>_<suffix>` (the currency of a `money` field).
 */
export interface ColumnSpec {
  readonly sql: ColumnSql;
  readonly check?: string;
  readonly companion?: {
    readonly suffix: string;
    readonly sql: ColumnSql;
    readonly check?: string;
  };
}

/** The form control a field is edited with. */
export type ControlKind =
  | 'input'
  | 'editor'
  | 'number'
  | 'money'
  | 'switch'
  | 'picker'
  | 'select'
  | 'people'
  | 'search'
  | 'uploader'
  | 'tags';

/** How a field is shown in a list. */
export type CellKind =
  | 'text'
  | 'excerpt'
  | 'number'
  | 'formatted'
  | 'check'
  | 'relative'
  | 'badge'
  | 'avatar'
  | 'link'
  | 'count'
  | 'chips';

/** A JSON Schema fragment, as an MCP tool advertises its input. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * One field of a resource, as a builder (`text()`, `enumOf()`, …) made it: branded and frozen, so
 * a hand-built object is refused by `defineResource`.
 *
 * `T` is the value type. `Optional` says whether the column is nullable (the value may be absent
 * or `null`); `Defaulted` whether a create may leave it out because the field has a default.
 */
export interface FieldDefinition<
  T = unknown,
  Optional extends boolean = boolean,
  Defaulted extends boolean = boolean,
> extends AppBranded<'field'> {
  readonly type: FieldType;
  readonly optional: Optional;
  /** The options the builder was given, after validation; `default` among them when set. */
  readonly options: Readonly<Record<string, unknown>>;
  /** Whether a create may omit the field because `options.default` fills it. */
  readonly defaulted: Defaulted;
  readonly column: ColumnSpec;
  /**
   * The value schema: what a create or update may write and a read returns, `null` aside. It is
   * non-enumerable, so it stays out of `JSON.stringify` and of a spread.
   */
  readonly zod: z.ZodType<T>;
  readonly control: ControlKind;
  readonly cell: CellKind;
  /** What the generated MCP tool advertises for this field. */
  readonly toolSchema: JsonSchema;
}

/** Any field, whatever its value type. */
export type AnyField = FieldDefinition<unknown>;

/** `true` when the options say `optional: true`. */
export type OptionalOf<O> = O extends { readonly optional: true } ? true : false;

/** `true` when the options carry a `default`. */
export type DefaultedOf<O> = O extends { readonly default: unknown } ? true : false;

/** Freezes a plain data value and everything under it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Parses a builder's options with its strict schema, throwing the SDK's `DefinitionError` with
 * every reason when they are refused.
 */
export function parseOptions<S extends z.ZodType>(
  subject: string,
  schema: S,
  options: unknown,
): z.output<S> {
  const result = schema.safeParse(options ?? {});
  if (!result.success) throw new DefinitionError(subject, issuesFromZod(result.error));
  return result.data;
}

/** The parts of a descriptor a builder supplies. */
export interface FieldParts<T> {
  readonly type: FieldType;
  readonly optional: boolean;
  readonly options: Readonly<Record<string, unknown>>;
  readonly column: ColumnSpec;
  readonly zod: z.ZodType<T>;
  readonly control: ControlKind;
  readonly cell: CellKind;
  readonly toolSchema: JsonSchema;
}

/**
 * Makes the branded, frozen descriptor. A `default` in the options must itself be a valid value,
 * so it is checked here once for every builder.
 */
export function makeField<T, Optional extends boolean, Defaulted extends boolean>(
  subject: string,
  parts: FieldParts<T>,
): FieldDefinition<T, Optional, Defaulted> {
  const fallback = parts.options['default'];
  const defaulted = fallback !== undefined;
  if (defaulted) {
    const result = parts.zod.safeParse(fallback);
    if (!result.success) {
      throw new DefinitionError(subject, issuesFromZod(result.error, 'default'));
    }
  }
  const descriptor = {
    type: parts.type,
    optional: parts.optional as Optional,
    options: deepFreeze({ ...parts.options }),
    defaulted: defaulted as Defaulted,
    column: deepFreeze({ ...parts.column }),
    control: parts.control,
    cell: parts.cell,
    toolSchema: deepFreeze({ ...parts.toolSchema }),
  };
  // The schema is not data: it is non-enumerable, so `JSON.stringify` of a field (and of a
  // resource) shows the descriptor alone.
  Object.defineProperties(descriptor, {
    zod: { value: parts.zod, enumerable: false, writable: false, configurable: false },
  });
  return brand(descriptor as typeof descriptor & { readonly zod: z.ZodType<T> }, 'field');
}

/** The option every builder accepts: `optional: true` makes the column nullable. */
export const baseOptions = { optional: z.boolean().optional() } as const;
