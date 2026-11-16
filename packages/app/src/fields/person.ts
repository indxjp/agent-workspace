import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The options of {@link person}. */
export interface PersonOptions {
  readonly optional?: boolean;
}

const PersonOptionsSchema = z.strictObject({ ...baseOptions });

/**
 * A person of the workspace: a `uuid` column holding a principal id (a platform row, referenced
 * by id without a foreign key), a people-picker control and an avatar cell. An `access` rule may
 * name a `person()` field to mean "the person in that field".
 *
 * The value is the principal id. The agent tool also accepts an email address and resolves it to
 * the id before writing.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function person<const O extends PersonOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<string, OptionalOf<O>, false> {
  const parsed = parseOptions('person()', PersonOptionsSchema, options);
  return makeField('person()', {
    type: 'person',
    optional: parsed.optional ?? false,
    options: parsed,
    column: { sql: 'uuid' },
    zod: z.uuid(),
    control: 'people',
    cell: 'avatar',
    toolSchema: {
      type: 'string',
      anyOf: [{ format: 'uuid' }, { format: 'email' }],
      description: 'A principal id or the email address of a workspace member.',
    },
  });
}
