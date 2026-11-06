/**
 * The Zod schemas a resource's records are checked with, built from its fields (issue #1501).
 *
 * One builder for every consumer: the store, the HTTP routes, the agent tools and the React form
 * all validate with these, so a create the form accepts is a create the route accepts. Pure: they
 * import none of Drizzle, Next.js or React.
 */
import { z } from 'zod';

import type { AnyField, FieldDefinition } from './fields/types.js';
import type { DefinedResource, FieldMap } from './resource.js';

/** The value type of a field. */
export type ValueOf<F> = F extends FieldDefinition<infer T, boolean, boolean> ? T : never;

type IsOptional<F> = F extends { readonly optional: true } ? true : false;
type IsDefaulted<F> = F extends { readonly defaulted: true } ? true : false;

/** A field's value as a read returns it: `null` when an optional field is unset. */
type StoredValue<F> = IsOptional<F> extends true ? ValueOf<F> | null : ValueOf<F>;

type RequiredOnCreate<F extends FieldMap> = {
  [K in keyof F]: IsOptional<F[K]> extends true
    ? never
    : IsDefaulted<F[K]> extends true
      ? never
      : K;
}[keyof F];

/**
 * What a create takes: every field that is neither optional nor defaulted, the others if wanted
 * (an optional one also as `null`).
 */
export type CreateInput<F extends FieldMap> = {
  readonly [K in RequiredOnCreate<F>]: ValueOf<F[K]>;
} & {
  readonly [K in Exclude<keyof F, RequiredOnCreate<F>>]?: StoredValue<F[K]>;
};

/** What an update takes: any of the fields, an optional one also as `null` to clear it. */
export type UpdateInput<F extends FieldMap> = {
  readonly [K in keyof F]?: StoredValue<F[K]>;
};

/** The columns every record has besides its fields. */
export interface ReservedColumns {
  readonly id: string;
  readonly workspace_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly updated_by: string;
}

/** A record as a read returns it: the reserved columns and every field. */
export type RecordOf<F extends FieldMap> = ReservedColumns & {
  readonly [K in keyof F]: StoredValue<F[K]>;
};

/** The schemas of the reserved columns: ids are uuids, times ISO 8601 with an offset. */
const RESERVED_SHAPE = {
  id: z.uuid(),
  workspace_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  created_by: z.uuid(),
  updated_by: z.uuid(),
} as const;

function shapeOf(
  fields: FieldMap,
  entry: (field: AnyField) => z.ZodType,
): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, entry(field)]));
}

/**
 * The schema of a create's body: a strict object of the fields, so an unknown key (a reserved
 * column among them) is refused. Optional and defaulted fields may be left out; an optional one
 * may also be `null`.
 */
export function createInputSchema<F extends FieldMap>(
  resource: DefinedResource<F>,
): z.ZodType<CreateInput<F>> {
  const schema = z.strictObject(
    shapeOf(resource.fields, (field) => {
      if (field.optional) return field.zod.nullable().optional();
      return field.defaulted ? field.zod.optional() : field.zod;
    }),
  );
  return schema as unknown as z.ZodType<CreateInput<F>>;
}

/**
 * The schema of an update's body: the create schema made partial, still strict. An optional field
 * may be set to `null` to clear it; a required one may not.
 */
export function updateInputSchema<F extends FieldMap>(
  resource: DefinedResource<F>,
): z.ZodType<UpdateInput<F>> {
  const schema = z.strictObject(
    shapeOf(resource.fields, (field) =>
      field.optional ? field.zod.nullable().optional() : field.zod.optional(),
    ),
  );
  return schema as unknown as z.ZodType<UpdateInput<F>>;
}

/**
 * The schema of a record as a read returns it: the reserved columns and every field, an optional
 * one as `null` when unset.
 */
export function recordSchema<F extends FieldMap>(
  resource: DefinedResource<F>,
): z.ZodType<RecordOf<F>> {
  const schema = z.strictObject({
    ...shapeOf(resource.fields, (field) => (field.optional ? field.zod.nullable() : field.zod)),
    ...RESERVED_SHAPE,
  });
  return schema as unknown as z.ZodType<RecordOf<F>>;
}
