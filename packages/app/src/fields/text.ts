import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type DefaultedOf,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The longest a `text()` field may be when `max` is not given. */
const TEXT_DEFAULT_MAX = 10_000;
/** The largest `max` a `text()` field accepts; longer prose belongs in `richText()`. */
const TEXT_MAX_LIMIT = 100_000;

/** The options of {@link text}. */
export interface TextOptions {
  /** The most characters the value may have, 1–100 000; 10 000 when not given. */
  readonly max?: number;
  readonly optional?: boolean;
  readonly default?: string;
}

const TextOptionsSchema = z.strictObject({
  ...baseOptions,
  max: z.int().min(1).max(TEXT_MAX_LIMIT).optional(),
  default: z.string().optional(),
});

/**
 * A line of text: a `text` column with a length check, a `z.string().max()` value, an input
 * control and a text cell.
 *
 * @throws {DefinitionError} when the options are refused (or the default is longer than `max`).
 */
export function text<const O extends TextOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<string, OptionalOf<O>, DefaultedOf<O>> {
  const parsed = parseOptions('text()', TextOptionsSchema, options);
  const max = parsed.max ?? TEXT_DEFAULT_MAX;
  return makeField('text()', {
    type: 'text',
    optional: parsed.optional ?? false,
    options: { ...parsed, max },
    column: { sql: 'text', check: `char_length({column}) <= ${String(max)}` },
    zod: z.string().max(max),
    control: 'input',
    cell: 'text',
    toolSchema: { type: 'string', maxLength: max },
  });
}
