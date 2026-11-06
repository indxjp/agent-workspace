import { DefinitionError, issuesFromZod } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { SNAKE_CASE } from '../names.js';
import {
  baseOptions,
  makeField,
  parseOptions,
  type DefaultedOf,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The most values an `enumOf()` field may have. */
const ENUM_MAX_VALUES = 100;

/** The options of {@link enumOf}. */
export interface EnumOptions<V extends string> {
  readonly default?: V;
  readonly optional?: boolean;
}

const EnumValuesSchema = z
  .array(z.string().max(63).regex(SNAKE_CASE, 'an enum value must be snake_case'))
  .min(1)
  .max(ENUM_MAX_VALUES)
  .refine((values) => new Set(values).size === values.length, {
    message: 'enum values must be unique',
  });

const EnumOptionsSchema = z.strictObject({ ...baseOptions, default: z.string().optional() });

/**
 * One of a fixed list: a `text` column with an `IN (…)` check, a `z.enum()` value, a select
 * control and a badge cell. A resource's `board` names an `enumOf()` field.
 *
 * @param values 1–100 unique snake_case values, in the order a select and a board show them.
 * @throws {DefinitionError} when the values or options are refused (or the default is not one of
 *   the values).
 */
export function enumOf<
  const V extends readonly [string, ...string[]],
  const O extends EnumOptions<V[number]> = Record<never, never>,
>(values: V, options?: O): FieldDefinition<V[number], OptionalOf<O>, DefaultedOf<O>> {
  const checked = EnumValuesSchema.safeParse(values);
  if (!checked.success) {
    throw new DefinitionError('enumOf()', issuesFromZod(checked.error, 'values'));
  }
  const parsed = parseOptions('enumOf()', EnumOptionsSchema, options);
  const list = [...values];
  return makeField('enumOf()', {
    type: 'enumOf',
    optional: parsed.optional ?? false,
    options: { ...parsed, values: list },
    column: {
      sql: 'text',
      check: `{column} IN (${list.map((value) => `'${value}'`).join(', ')})`,
    },
    zod: z.enum(values),
    control: 'select',
    cell: 'badge',
    toolSchema: { type: 'string', enum: list },
  });
}
