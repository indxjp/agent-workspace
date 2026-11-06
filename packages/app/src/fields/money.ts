import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/**
 * An amount as a decimal string (up to 15 integer and 4 fraction digits), so `numeric` stores it
 * exactly; a JavaScript number would round cents.
 */
const MONEY_AMOUNT_PATTERN = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/u;

/** A money value: an exact decimal amount in the field's currency. */
export interface Money<C extends string = string> {
  readonly amount: string;
  readonly currency: C;
}

/** The options of {@link money}. */
export interface MoneyOptions {
  /** The ISO 4217 code every value of the field is in, such as `JPY` or `USD`. */
  readonly currency: string;
  readonly optional?: boolean;
}

const MoneyOptionsSchema = z.strictObject({
  ...baseOptions,
  currency: z.string().regex(/^[A-Z]{3}$/u, 'currency must be an ISO 4217 code such as "JPY"'),
});

/**
 * An amount of money in one currency: a `numeric` column with a `<field>_currency` text column
 * beside it, an `{ amount, currency }` value, a money control and a formatted cell.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function money<const O extends MoneyOptions>(
  options: O,
): FieldDefinition<Money<O['currency']>, OptionalOf<O>, false> {
  const parsed = parseOptions('money()', MoneyOptionsSchema, options);
  const currency = parsed.currency as O['currency'];
  return makeField('money()', {
    type: 'money',
    optional: parsed.optional ?? false,
    options: parsed,
    column: {
      sql: 'numeric',
      companion: { suffix: 'currency', sql: 'text', check: `{column} = '${currency}'` },
    },
    zod: z.strictObject({
      amount: z.string().regex(MONEY_AMOUNT_PATTERN, 'amount must be a decimal string'),
      currency: z.literal(currency),
    }),
    control: 'money',
    cell: 'formatted',
    toolSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string', pattern: MONEY_AMOUNT_PATTERN.source },
        currency: { type: 'string', const: currency },
      },
      required: ['amount', 'currency'],
      additionalProperties: false,
    },
  });
}
