import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The options of {@link number}. Bounds are inclusive and must be safe integers. */
export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly optional?: boolean;
}

const Bound = z.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional();

const NumberOptionsSchema = z
  .strictObject({ ...baseOptions, min: Bound, max: Bound })
  .refine(({ min, max }) => min === undefined || max === undefined || min <= max, {
    message: 'min must not be greater than max',
    path: ['min'],
  });

function checkOf(min: number | undefined, max: number | undefined): string | undefined {
  const parts = [
    ...(min === undefined ? [] : [`{column} >= ${String(min)}`]),
    ...(max === undefined ? [] : [`{column} <= ${String(max)}`]),
  ];
  return parts.length === 0 ? undefined : parts.join(' AND ');
}

/**
 * A number: a `numeric` column (with a range check when bounded), a finite `z.number()` value, a
 * number control and a number cell.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function number<const O extends NumberOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<number, OptionalOf<O>, false> {
  const parsed = parseOptions('number()', NumberOptionsSchema, options);
  let value = z.number();
  if (parsed.min !== undefined) value = value.min(parsed.min);
  if (parsed.max !== undefined) value = value.max(parsed.max);
  const check = checkOf(parsed.min, parsed.max);
  return makeField('number()', {
    type: 'number',
    optional: parsed.optional ?? false,
    options: parsed,
    column: check === undefined ? { sql: 'numeric' } : { sql: 'numeric', check },
    zod: value,
    control: 'number',
    cell: 'number',
    toolSchema: {
      type: 'number',
      ...(parsed.min === undefined ? {} : { minimum: parsed.min }),
      ...(parsed.max === undefined ? {} : { maximum: parsed.max }),
    },
  });
}
