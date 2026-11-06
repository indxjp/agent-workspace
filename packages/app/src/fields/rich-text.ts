import { z } from 'zod';

import {
  baseOptions,
  makeField,
  parseOptions,
  type FieldDefinition,
  type OptionalOf,
} from './types.js';

/** How deeply rich-text blocks may nest. */
const RICH_TEXT_MAX_DEPTH = 8;
/** The most bytes a rich-text value may take serialised as JSON (256 KiB). */
const RICH_TEXT_MAX_BYTES = 256 * 1024;

/** One block of a rich-text document: a typed node with text, children, or both. */
export interface RichTextBlock {
  readonly type: string;
  readonly text?: string | undefined;
  readonly children?: readonly RichTextBlock[] | undefined;
}

const RichTextBlockSchema: z.ZodType<RichTextBlock> = z.strictObject({
  type: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/u),
  text: z.string().optional(),
  get children() {
    return z.array(RichTextBlockSchema).optional();
  },
});

function depthOf(blocks: readonly RichTextBlock[]): number {
  return blocks.reduce((deepest, block) => {
    const below = block.children === undefined ? 0 : depthOf(block.children);
    return Math.max(deepest, 1 + below);
  }, 0);
}

/** A rich-text value: a JSON array of blocks, nested at most 8 deep and at most 256 KiB. */
const RichTextSchema = z
  .array(RichTextBlockSchema)
  .refine((blocks) => depthOf(blocks) <= RICH_TEXT_MAX_DEPTH, {
    message: `blocks may nest at most ${String(RICH_TEXT_MAX_DEPTH)} deep`,
  })
  .refine(
    (blocks) => new TextEncoder().encode(JSON.stringify(blocks)).length <= RICH_TEXT_MAX_BYTES,
    { message: `a rich-text value may be at most ${String(RICH_TEXT_MAX_BYTES)} bytes as JSON` },
  );

/** The options of {@link richText}. */
export interface RichTextOptions {
  readonly optional?: boolean;
}

const RichTextOptionsSchema = z.strictObject({ ...baseOptions });

/**
 * A document: a `jsonb` column of blocks, an editor control and an excerpt cell. The agent tool
 * reads and writes it as markdown; the conversion lands with the tool handlers.
 *
 * @throws {DefinitionError} when the options are refused.
 */
export function richText<const O extends RichTextOptions = Record<never, never>>(
  options?: O,
): FieldDefinition<RichTextBlock[], OptionalOf<O>, false> {
  const parsed = parseOptions('richText()', RichTextOptionsSchema, options);
  return makeField('richText()', {
    type: 'richText',
    optional: parsed.optional ?? false,
    options: parsed,
    column: { sql: 'jsonb', check: `jsonb_typeof({column}) = 'array'` },
    zod: RichTextSchema,
    control: 'editor',
    cell: 'excerpt',
    toolSchema: { type: 'string', contentMediaType: 'text/markdown' },
  });
}
