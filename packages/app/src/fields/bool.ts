import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type DefaultedOf,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The options of {@link bool}. */
export interface BoolOptions {
  readonly optional?: boolean;
  readonly default?: boolean;
}

const BoolOptionsSchema = z.strictObject({ ...baseOptions, default: z.boolean().optional() });

/**
 * A yes or no: a `boolean` column, a `z.boolean()` value, a switch control and a check cell.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function bool<const O extends BoolOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<boolean, OptionalOf<O>, DefaultedOf<O>> {
  const parsed = parseOptions('bool()', BoolOptionsSchema, options);
  return makeField('bool()', {
    type: 'bool',
    optional: parsed.optional ?? false,
    options: parsed,
    column: { sql: 'boolean' },
    zod: z.boolean(),
    control: 'switch',
    cell: 'check',
    toolSchema: { type: 'boolean' },
  });
}
