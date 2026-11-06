/**
 * The decisions both page stores make the same way (issue #1520): what a page create, update and
 * move may carry, when a save is a new revision, where a new page goes, and what search indexes.
 * Pure: the PostgreSQL page store and the in-memory one differ only in where the pages are kept,
 * as `policy.ts` is for every resource.
 */
import { z } from 'zod';

import type { RichTextBlock } from '../fields/rich-text.js';
import { blocksPlainText, pageBlockIssues } from '../pages/blocks.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import { AppStoreError } from './errors.js';
import type { PageMove, PageStore } from './page-port.js';
import {
  assertAgentMayWrite,
  assertAllowed,
  prepareCreate,
  prepareUpdate,
  recordIdOf,
  searchTextOf,
  type FieldValues,
  type PreparedWrite,
} from './policy.js';
import type { ResourceStore } from './port.js';
import { searchQuery, searchTerms } from './search-terms.js';

/** A page resource, as the stores take it. */
export type PageResource = DefinedPages<FieldMap>;

/** The most children one `children` answer holds. */
export const CHILDREN_MAX = 500;

/**
 * The most characters of terms a page's search text keeps.
 *
 * shortcut: search covers the first 100 000 characters of a page's terms, which keeps the indexed
 * column well inside PostgreSQL's limits for a 256 KiB body; upgrade to passages (as the
 * platform's file search keeps them) when pages grow longer.
 */
const SEARCH_TEXT_MAX = 100_000;

/** The patch key an update's optimistic check travels under; no field is camelCase. */
const EXPECTED_KEY = 'expectedRevisionId';

/** The two fields whose change is a new revision. */
const REVISED_FIELDS = ['title', 'blocks'] as const;

/** The space-separated terms of a page's title and the text of its blocks, which search indexes. */
export function pageSearchText(title: string, blocks: readonly RichTextBlock[]): string {
  const terms = searchTerms(`${title}\n${blocksPlainText(blocks)}`).join(' ');
  if (terms.length <= SEARCH_TEXT_MAX) return terms;
  const cut = terms.lastIndexOf(' ', SEARCH_TEXT_MAX);
  return terms.slice(0, cut === -1 ? SEARCH_TEXT_MAX : cut);
}

/** A page search's text, and the `to_tsquery('simple', …)` string of its terms. */
export interface PageQuery {
  readonly text: string;
  readonly tsquery: string;
}

/**
 * The query of a page search.
 *
 * @throws {AppStoreError} `invalid_query` for a blank or overlong text, or one with no term.
 */
export function pageQueryOf(resource: PageResource, query: string): PageQuery {
  const text = searchTextOf(resource, query);
  const tsquery = searchQuery(text);
  if (tsquery === null) throw new AppStoreError('invalid_query', { details: ['q'] });
  return { text, tsquery };
}

/** The `k` of a page's revision cursors: `<app>.<plural>:revisions:<page id>`. */
export function revisionsKeyOf(appName: string, resource: DefinedResource, pageId: string): string {
  return `${appName}.${resource.plural}:revisions:${pageId}`;
}

/** The place after `positions`: one more than the highest, `0` for the first child. */
export function nextPosition(positions: readonly number[]): number {
  return positions.length === 0 ? 0 : Math.floor(Math.max(...positions)) + 1;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPageBlocks(values: FieldValues): void {
  if (!Object.hasOwn(values, 'blocks')) return;
  const issues = pageBlockIssues(values['blocks']);
  if (issues.length > 0) throw new AppStoreError('invalid_body', { details: issues });
}

/**
 * Validates a page create, as `prepareCreate` does for any resource, with `blocks` (empty) and
 * `position` (after the siblings, by `place`) filled in when the input leaves them out, and every
 * block of a type a page holds.
 *
 * @throws {AppStoreError} `invalid_body` or `forbidden`.
 */
export async function preparePageCreate(
  resource: PageResource,
  person: Person,
  input: unknown,
  place: (parent: string | null) => Promise<number>,
): Promise<PreparedWrite> {
  if (!isRecord(input)) return prepareCreate(resource, person, input);
  const parent = typeof input['parent'] === 'string' ? (recordIdOf(input['parent']) ?? null) : null;
  const filled = {
    ...input,
    ...(Object.hasOwn(input, 'blocks') ? {} : { blocks: [] }),
    ...(Object.hasOwn(input, 'position') ? {} : { position: await place(parent) }),
  };
  const prepared = prepareCreate(resource, person, filled);
  assertPageBlocks(prepared.values);
  return prepared;
}

/** A page update's patch, and the revision it expects the page to be at. */
export interface PreparedPageUpdate extends PreparedWrite {
  readonly expectedRevisionId?: string;
}

/**
 * Validates a page update: the patch as `prepareUpdate` reads it, without `expectedRevisionId`,
 * which must be a revision id when present.
 *
 * @throws {AppStoreError} `invalid_body` or `forbidden`.
 */
export function preparePageUpdate(
  resource: PageResource,
  person: Person,
  patch: unknown,
): PreparedPageUpdate {
  if (!isRecord(patch) || !Object.hasOwn(patch, EXPECTED_KEY)) {
    const prepared = prepareUpdate(resource, person, patch);
    assertPageBlocks(prepared.values);
    return prepared;
  }
  const { [EXPECTED_KEY]: expected, ...rest } = patch;
  const expectedRevisionId = typeof expected === 'string' ? recordIdOf(expected) : undefined;
  if (expectedRevisionId === undefined) {
    throw new AppStoreError('invalid_body', { details: [EXPECTED_KEY] });
  }
  const prepared = prepareUpdate(resource, person, rest);
  assertPageBlocks(prepared.values);
  return { ...prepared, expectedRevisionId };
}

/**
 * Refuses an update that would place the page elsewhere: `parent` and `space` change through
 * `move`, where the tree is checked. Writing their current value back (a form saving every field)
 * is no change.
 *
 * @throws {AppStoreError} `invalid_body` naming the field.
 */
export function assertPlacementKept(existing: FieldValues, values: FieldValues): void {
  const moved = ['parent', 'space'].filter(
    (field) =>
      Object.hasOwn(values, field) && (values[field] ?? null) !== (existing[field] ?? null),
  );
  if (moved.length > 0) throw new AppStoreError('invalid_body', { details: moved });
}

/** Whether writing `values` over `existing` changes the title or the body: a new revision. */
export function isRevision(existing: FieldValues, values: FieldValues): boolean {
  return REVISED_FIELDS.some(
    (field) =>
      Object.hasOwn(values, field) &&
      JSON.stringify(values[field]) !== JSON.stringify(existing[field]),
  );
}

/**
 * Refuses a write made against a revision that is no longer the page's newest.
 *
 * @throws {AppStoreError} `page_conflict`.
 */
export function assertExpectedRevision(current: unknown, expected: string | undefined): void {
  if (expected !== undefined && current !== expected) throw new AppStoreError('page_conflict');
}

const MoveSchema = z.strictObject({
  parent: z.uuid().nullable(),
  position: z.number().finite(),
});

/**
 * Validates a move for `person`: the body, the agent rule on `parent` and `position`. The update
 * rule and the tree are checked by the store, on the stored pages.
 *
 * @throws {AppStoreError} `invalid_body` or `forbidden`.
 */
export function prepareMove(resource: PageResource, person: Person, move: unknown): PageMove {
  assertAgentMayWrite(resource, person, ['parent', 'position']);
  const result = MoveSchema.safeParse(move);
  if (!result.success) {
    const details = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '$'))];
    throw new AppStoreError('invalid_body', { details });
  }
  const parent = result.data.parent === null ? null : result.data.parent.toLowerCase();
  return { parent, position: Object.is(result.data.position, -0) ? 0 : result.data.position };
}

/**
 * Refuses placing `page` under `parent`: a cycle when `parent` is the page or below it (`chain`
 * is `parent` and its ancestors), a space mismatch when the two are in different spaces.
 *
 * @throws {AppStoreError} `page_cycle` or `page_space_mismatch`.
 */
export function assertPlacement(
  resource: PageResource,
  page: FieldValues & { readonly id?: string },
  parent: FieldValues | null,
  chain: readonly string[],
): void {
  if (page.id !== undefined && chain.includes(page.id)) throw new AppStoreError('page_cycle');
  if (resource.space && parent !== null && parent['space'] !== page['space']) {
    throw new AppStoreError('page_space_mismatch');
  }
}

/**
 * The checks of a delete on the stored page: the delete rule, and the children unless `cascade`.
 * The agent rule is checked before the page is read, with `assertAgentMayWrite`.
 *
 * @throws {AppStoreError} `forbidden` or `page_has_children`.
 */
export function assertDeletable(
  resource: PageResource,
  person: Person,
  page: FieldValues,
  hasChildren: boolean,
  cascade: boolean,
): void {
  assertAllowed('delete', resource, person, page);
  if (hasChildren && !cascade) throw new AppStoreError('page_has_children');
}

/**
 * Refuses a restore an agent may not make: it writes the title and the blocks.
 *
 * @throws {AppStoreError} `forbidden`.
 */
export function assertMayRestore(resource: PageResource, person: Person): void {
  assertAgentMayWrite(resource, person, [...REVISED_FIELDS]);
}

/** Whether `store` is a page store: it has the tree and the revisions. */
export function isPageStore(store: ResourceStore): store is PageStore {
  const candidate = store as Partial<Record<keyof PageStore, unknown>>;
  return (
    typeof candidate.children === 'function' &&
    typeof candidate.move === 'function' &&
    typeof candidate.revisions === 'function' &&
    typeof candidate.restore === 'function'
  );
}
