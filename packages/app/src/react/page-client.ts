/**
 * `pageClient`: the browser's way to a `definePages` resource's routes (issue #1521), the record
 * routes of `resourceClient` and the page routes of `pageRoutes` (`children`, `revisions`,
 * `restore`, `move`), so the page tree and the page view never call `fetch` themselves.
 *
 * It sends with `resourceClient`'s own requester, so every answer is parsed the same way: a page
 * with the resource's record schema and its `revision_id`, a revision with its own strict schema,
 * and a failure as the problem envelope (ADR-0075), one {@link ResourceProblemError}.
 */
import { z } from 'zod';

import type { PageMove, PageRecord, PageRevision } from '../db/page-port.js';
import { richText, type RichTextBlock } from '../fields/rich-text.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { FieldMap } from '../resource.js';
import { recordSchema } from '../schemas.js';
import {
  resourcePaths,
  resourceRequester,
  type ResourceClientOptions,
  type ResourcePage,
} from './client.js';

/** What a new page is given: its title and body, where it goes, and its space when kept in one. */
export interface PageCreateInput {
  readonly title: string;
  readonly blocks: readonly RichTextBlock[];
  /** The page it goes under; the top when `null` or not given. It goes after its siblings. */
  readonly parent?: string | null;
  /** The space it belongs to, for pages kept in spaces. */
  readonly space?: string;
}

/** What a save sends: the title, the body, or both, and the revision the person last read. */
export interface PageUpdate {
  readonly title?: string;
  readonly blocks?: readonly RichTextBlock[];
  /** Refuses the save `409 page_conflict` when the page has a newer revision. */
  readonly expectedRevisionId?: string;
}

/** What one read may be told: the abort of the page that asked. */
export interface PageReadOptions {
  readonly signal?: AbortSignal | undefined;
}

/** A page of revisions: after `cursor`, at most `limit`. */
export interface PageRevisionsQuery extends PageReadOptions {
  readonly cursor?: string | null | undefined;
  readonly limit?: number | undefined;
}

/** The routes of one page resource, typed by its fields. */
export interface PageClient<F extends FieldMap = FieldMap> {
  get(id: string, options?: PageReadOptions): Promise<PageRecord<F>>;
  /** The pages directly under `parent` (`null`: the top), lowest `position` first. */
  children(parent: string | null, options?: PageReadOptions): Promise<readonly PageRecord<F>[]>;
  create(input: PageCreateInput): Promise<PageRecord<F>>;
  update(id: string, patch: PageUpdate): Promise<PageRecord<F>>;
  move(id: string, move: PageMove): Promise<PageRecord<F>>;
  /** The page's revisions, newest first. */
  revisions(id: string, query?: PageRevisionsQuery): Promise<ResourcePage<PageRevision>>;
  /** Writes `revisionId`'s title and body as a new revision. */
  restore(
    id: string,
    revisionId: string,
    options?: { readonly expectedRevisionId?: string },
  ): Promise<PageRecord<F>>;
}

/** A page as the routes answer it: the record schema's fields and its `revision_id`. */
function pageRecordSchema<F extends FieldMap>(resource: DefinedPages<F>): z.ZodType<PageRecord<F>> {
  const record = recordSchema(resource);
  return z.unknown().transform((value, context): PageRecord<F> => {
    const { revision_id: revisionId, ...rest } =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const id = z.uuid().safeParse(revisionId);
    const parsed = record.safeParse(rest);
    if (!id.success || !parsed.success) {
      context.addIssue({ code: 'custom', message: 'not a page of this resource' });
      return z.NEVER;
    }
    return { ...parsed.data, revision_id: id.data };
  });
}

const RevisionSchema: z.ZodType<PageRevision> = z.strictObject({
  id: z.uuid(),
  workspace_id: z.uuid(),
  page_id: z.uuid(),
  title: z.string(),
  blocks: richText().zod,
  author_principal_id: z.string().min(1),
  run_id: z.string().min(1).nullable(),
  at: z.iso.datetime({ offset: true }),
});

const CursorSchema = z.string().min(1).nullable();

/**
 * Builds the client of a page resource's routes. Every answer is parsed; a failure is one
 * {@link ResourceProblemError}, its code the route's own (`page_conflict`, `page_cycle`…).
 */
export function pageClient<F extends FieldMap>(
  resource: DefinedPages<F>,
  options: ResourceClientOptions = {},
): PageClient<F> {
  const request = resourceRequester(resource, options);
  const page = pageRecordSchema(resource);
  const pages = z.strictObject({ items: z.array(page) });
  const revisions = z.strictObject({ items: z.array(RevisionSchema), nextCursor: CursorSchema });
  const { collection, item } = resourcePaths(resource);

  return {
    get: (id, read) =>
      request({ method: 'GET', path: item(id), expect: 200, schema: page, signal: read?.signal }),
    async children(parent, read) {
      const suffix = parent === null ? '' : `?${new URLSearchParams({ parent }).toString()}`;
      const answer = await request({
        method: 'GET',
        path: `${collection}/children${suffix}`,
        expect: 200,
        schema: pages,
        signal: read?.signal,
      });
      return answer.items;
    },
    create: (input) =>
      request({ method: 'POST', path: collection, body: input, expect: 201, schema: page }),
    update: (id, patch) =>
      request({ method: 'PATCH', path: item(id), body: patch, expect: 200, schema: page }),
    move: (id, move) =>
      request({ method: 'POST', path: `${item(id)}/move`, body: move, expect: 200, schema: page }),
    revisions(id, query = {}) {
      const search = new URLSearchParams();
      if (query.cursor !== undefined && query.cursor !== null) search.set('cursor', query.cursor);
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      const suffix = search.size === 0 ? '' : `?${search.toString()}`;
      return request({
        method: 'GET',
        path: `${item(id)}/revisions${suffix}`,
        expect: 200,
        schema: revisions,
        signal: query.signal,
      });
    },
    restore: (id, revisionId, restoreOptions = {}) =>
      request({
        method: 'POST',
        path: `${item(id)}/restore`,
        body: { revisionId, ...restoreOptions },
        expect: 200,
        schema: page,
      }),
  };
}
