import { DefinitionError, issuesFromZod } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { SnakeCaseNameSchema } from '../names.js';
import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The options of {@link ref}. */
export interface RefOptions {
  readonly optional?: boolean;
}

const RefOptionsSchema = z.strictObject({ ...baseOptions });

/**
 * A link to a record of another resource of the same app: a `uuid` column with a foreign key in
 * the app's schema, a search-picker control and a link cell.
 *
 * The target is named, not imported, so two resources may reference each other without an import
 * cycle; `defineApp` checks that every name resolves.
 *
 * @param resource the target resource's `name`.
 * @throws {DefinitionError} when the name or options are refused.
 */
export function ref<const R extends string, const O extends RefOptions = Record<never, never>>(
  resource: R,
  options?: O,
): FieldDefinition<string, OptionalOf<O>, false> {
  const name = SnakeCaseNameSchema.safeParse(resource);
  if (!name.success) throw new DefinitionError('ref()', issuesFromZod(name.error, 'resource'));
  const parsed = parseOptions('ref()', RefOptionsSchema, options);
  return makeField('ref()', {
    type: 'ref',
    optional: parsed.optional ?? false,
    options: { ...parsed, resource: name.data },
    column: { sql: 'uuid' },
    zod: z.uuid(),
    control: 'search',
    cell: 'link',
    toolSchema: { type: 'string', format: 'uuid', description: `The id of a ${name.data}.` },
  });
}
