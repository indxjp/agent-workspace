import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** The most tags one `tags()` field may hold. */
const TAGS_MAX = 100;
/** The longest one tag may be. */
const TAG_MAX_LENGTH = 64;

/** The options of {@link tags}. */
export interface TagsOptions {
  readonly optional?: boolean;
}

const TagsOptionsSchema = z.strictObject({ ...baseOptions });

/**
 * Free labels: a `text[]` column, an array of 1–64-character strings (at most 100), a tag-input
 * control and a chips cell.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function tags<const O extends TagsOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<string[], OptionalOf<O>, false> {
  const parsed = parseOptions('tags()', TagsOptionsSchema, options);
  return makeField('tags()', {
    type: 'tags',
    optional: parsed.optional ?? false,
    options: parsed,
    column: { sql: 'text[]', check: `cardinality({column}) <= ${String(TAGS_MAX)}` },
    zod: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAGS_MAX),
    control: 'tags',
    cell: 'chips',
    toolSchema: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: TAG_MAX_LENGTH },
      maxItems: TAGS_MAX,
    },
  });
}
