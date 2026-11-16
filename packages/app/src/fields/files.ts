import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The most files one `files()` field may hold. */
const FILES_MAX = 100;

/** The options of {@link files}. */
export interface FilesOptions {
  readonly optional?: boolean;
}

const FilesOptionsSchema = z.strictObject({ ...baseOptions });

/**
 * Attachments of a record: a `uuid[]` column of platform file ids (referenced by id without a
 * foreign key), at most 100, an uploader control and a count cell.
 *
 * Not `@indx-workspace/sdk/define`'s `files()`, which grants an agent access to files; this one is
 * a field of a resource. A resource file and an agent file never import both.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function files<const O extends FilesOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<string[], OptionalOf<O>, false> {
  const parsed = parseOptions('files()', FilesOptionsSchema, options);
  return makeField('files()', {
    type: 'files',
    optional: parsed.optional ?? false,
    options: parsed,
    column: { sql: 'uuid[]', check: `cardinality({column}) <= ${String(FILES_MAX)}` },
    zod: z.array(z.uuid()).max(FILES_MAX),
    control: 'uploader',
    cell: 'count',
    toolSchema: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      maxItems: FILES_MAX,
      description: 'Platform file ids.',
    },
  });
}
