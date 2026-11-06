import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The options of {@link date} and {@link dateTime}. */
export interface DateOptions {
  readonly optional?: boolean;
}

const DateOptionsSchema = z.strictObject({ ...baseOptions });

/**
 * A calendar day: a `date` column, an ISO `YYYY-MM-DD` string value, a picker control and a
 * relative cell.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function date<const O extends DateOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<string, OptionalOf<O>, false> {
  const parsed = parseOptions('date()', DateOptionsSchema, options);
  return makeField('date()', {
    type: 'date',
    optional: parsed.optional ?? false,
    options: parsed,
    column: { sql: 'date' },
    zod: z.iso.date(),
    control: 'picker',
    cell: 'relative',
    toolSchema: { type: 'string', format: 'date' },
  });
}

/**
 * An instant: a `timestamptz` column, an ISO 8601 date-time string value with an offset (`Z` or
 * `+09:00`), a picker control and a relative cell.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function dateTime<const O extends DateOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<string, OptionalOf<O>, false> {
  const parsed = parseOptions('dateTime()', DateOptionsSchema, options);
  return makeField('dateTime()', {
    type: 'dateTime',
    optional: parsed.optional ?? false,
    options: parsed,
    column: { sql: 'timestamptz' },
    zod: z.iso.datetime({ offset: true }),
    control: 'picker',
    cell: 'relative',
    toolSchema: { type: 'string', format: 'date-time' },
  });
}
