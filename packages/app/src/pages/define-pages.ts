/**
 * `definePages`: the page resource kind of the app kit (F-6, issue #1520), a preset over
 * `defineResource` with the fields every page has. A page nests under another page, keeps a
 * rich-text body of blocks, and every save of its title or body leaves a revision in the app's own
 * `<name>_revisions` table. Pure: the store, routes and agent tools of `./db` and `./server` read
 * the `kind` it brands.
 */
import { DefinitionError, issuesFromZod, type DefinitionIssue } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { brand } from '../brand.js';
import { number, ref, richText, text } from '../fields/index.js';
import type { FieldDefinition } from '../fields/types.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import {
  defineResource,
  isDefinedResource,
  type AccessOperation,
  type AccessRules,
  type DefinedResource,
  type FieldMap,
} from '../resource.js';

/** The longest a page title may be. */
export const PAGE_TITLE_MAX = 300;

/** The fields every page has. */
export type PageBaseFields = {
  readonly title: FieldDefinition<string, false, false>;
  /** The page it nests under; `null` for a page at the top. */
  readonly parent: FieldDefinition<string, true, false>;
  /** Its place among its siblings, lowest first. */
  readonly position: FieldDefinition<number, false, false>;
  readonly blocks: FieldDefinition<RichTextBlock[], false, false>;
};

/** The fields of pages kept in spaces (`space: true`): every page names its `space`. */
export type PageSpaceFields = PageBaseFields & {
  readonly space: FieldDefinition<string, false, false>;
};

/** A field a page has. */
export type PageFieldName = keyof PageSpaceFields;

/** What {@link definePages} accepts. */
export interface PagesInput<S extends boolean = false> {
  /** snake_case; `page` when not given. Its revisions table is `<name>_revisions`. */
  readonly name?: string;
  /** The table and route name; `name + 's'` when not given. */
  readonly plural?: string;
  /** Whether every page belongs to a record of the app's `space` resource: `ref('space')`. */
  readonly space?: S;
  readonly access: Readonly<Record<AccessOperation, AccessRules>>;
  /**
   * What agents acting for a person may do, as for `defineResource`. When `write` lists a field,
   * `position` joins it: the store places a page an agent creates after its siblings. The agent
   * tools write `title` and `blocks`; `<name>_create` needs both, and `parent` to create a page
   * under another one.
   */
  readonly agents?: {
    readonly read: boolean;
    readonly write: readonly PageFieldName[] | false;
  };
  /** Whether writes leave audit rows; `true` when not given. */
  readonly audit?: boolean;
}

/** What {@link definePages} returns: a defined resource branded as the page kind. */
export type DefinedPages<F extends FieldMap = PageBaseFields> = DefinedResource<F> & {
  readonly kind: 'page';
  /** Whether the pages are kept in spaces. */
  readonly space: boolean;
};

const PagesInputSchema = z.strictObject({
  name: z.string().optional(),
  plural: z.string().optional(),
  space: z.boolean().optional(),
  access: z.unknown(),
  agents: z.unknown().optional(),
  audit: z.unknown().optional(),
});

const KNOWN_KEYS = Object.keys(PagesInputSchema.shape);
const DEFAULT_NAME = 'page';

function pageFieldsOf(name: string, space: boolean): FieldMap {
  return {
    title: text({ max: PAGE_TITLE_MAX }),
    parent: ref(name, { optional: true }),
    position: number(),
    blocks: richText(),
    ...(space ? { space: ref('space') } : {}),
  };
}

/** `agents` as written, with `position` added to a `write` list that names any field. */
function agentsOf(agents: unknown): unknown {
  if (typeof agents !== 'object' || agents === null) return agents;
  const write = (agents as { readonly write?: unknown }).write;
  if (!Array.isArray(write) || write.length === 0 || write.includes('position')) return agents;
  return { ...agents, write: [...(write as unknown[]), 'position'] };
}

/** The issues of the preset's own shape: an unknown key (`fields`, `search`…), a bad `space`. */
function presetIssues(input: unknown): readonly DefinitionIssue[] {
  const result = PagesInputSchema.safeParse(input);
  return result.success ? [] : issuesFromZod(result.error, undefined, KNOWN_KEYS);
}

/**
 * Defines the pages of a portal app: `title` (`text({ max: 300 })`), `parent` (an optional `ref`
 * to a page), `position` (`number()`), `blocks` (`richText()`) and, with `space: true`, `space`
 * (`ref('space')`, so the app must define a `space` resource). Search covers the title and the
 * text of the blocks.
 *
 * Every mistake is reported at once, the preset's and `defineResource`'s: an unknown key (the
 * fields, `search` and `board` are fixed), an access rule naming a field, `agents.write` naming a
 * field pages do not have.
 *
 * @throws {DefinitionError} with every reason the input was refused.
 */
export function definePages<const S extends boolean = false>(
  input: PagesInput<S>,
): DefinedPages<S extends true ? PageSpaceFields : PageBaseFields> {
  const issues = [...presetIssues(input)];
  const raw = input as unknown as Readonly<Record<string, unknown>>;
  const name = typeof raw['name'] === 'string' ? raw['name'] : DEFAULT_NAME;
  const space = raw['space'] === true;
  let resource: DefinedResource | undefined;
  try {
    resource = defineResource({
      name,
      ...(raw['plural'] === undefined ? {} : { plural: raw['plural'] as string }),
      fields: pageFieldsOf(name, space),
      access: raw['access'] as PagesInput['access'],
      ...(raw['agents'] === undefined
        ? {}
        : { agents: agentsOf(raw['agents']) as NonNullable<PagesInput['agents']> }),
      search: ['title', 'blocks'],
      ...(raw['audit'] === undefined ? {} : { audit: raw['audit'] as boolean }),
    });
  } catch (error) {
    if (!(error instanceof DefinitionError)) throw error;
    issues.push(...error.issues);
  }
  if (resource === undefined || issues.length > 0) {
    throw new DefinitionError('definePages()', issues);
  }
  return brand(
    { ...resource, kind: 'page' as const, space },
    'resource',
  ) as unknown as DefinedPages<S extends true ? PageSpaceFields : PageBaseFields>;
}

/** Whether `value` is a resource made by {@link definePages}. */
export function isPageResource(value: unknown): value is DefinedPages<FieldMap> {
  return isDefinedResource(value) && (value as { readonly kind?: unknown }).kind === 'page';
}
