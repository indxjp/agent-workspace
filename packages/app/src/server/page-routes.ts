/**
 * The page routes of a `definePages` resource (issue #1520), beside its `resourceRoutes`: a page's
 * revisions, a restore and a move, as Next.js route handlers on Web `Request` and `Response`. Each
 * generated route file is one line, such as
 * `export const { GET } = pageRoutes(page).revisions;` in `app/api/pages/[id]/revisions/route.ts`.
 *
 * Every handler asks Agent Workspace who the person is and runs the page store as them, so the
 * pages' access rules decide; a route never checks access itself and never writes SQL. Every answer
 * carries `cache-control: no-store`; every failure is the one problem envelope (ADR-0075).
 */
import { z } from 'zod';

import { AppStoreError } from '../db/errors.js';
import type { PageStore } from '../db/page-port.js';
import { recordIdOf } from '../db/policy.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import type { FieldMap } from '../resource.js';
import { currentPerson } from './person.js';
import { NO_STORE, problem } from './problem.js';
import {
  jsonBodyOf,
  refusalOf,
  type CollectionHandler,
  type ItemHandler,
  type ItemRouteContext,
} from './routes.js';
import { appRuntime } from './runtime.js';

/**
 * The handlers of the page route files: three under `app/api/<plural>/[id]/`, and `children`
 * beside `[id]` (`app/api/<plural>/children/route.ts`), which the page tree loads level by level.
 */
export interface PageRoutes {
  /** `children/route.ts`: `GET ?parent=<id>`, the pages under it; the top without `parent`. */
  readonly children: { readonly GET: CollectionHandler };
  /** `revisions/route.ts`: `GET ?cursor=&limit=`, newest first. */
  readonly revisions: { readonly GET: ItemHandler };
  /** `restore/route.ts`: `POST { revisionId, expectedRevisionId? }`. */
  readonly restore: { readonly POST: ItemHandler };
  /** `move/route.ts`: `POST { parent, position }`. */
  readonly move: { readonly POST: ItemHandler };
}

const LIMIT = /^[0-9]{1,6}$/u;

const RestoreBodySchema = z.strictObject({
  revisionId: z.string().min(1).max(64),
  expectedRevisionId: z.string().min(1).max(64).optional(),
});

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': NO_STORE } });
}

type Operation<F extends FieldMap, K> = (
  person: Person,
  store: PageStore<F>,
  key: K,
) => Promise<Response>;

/** Resolves the store, the person and the key, runs `operation`, and renders what it throws. */
async function serve<F extends FieldMap, K>(
  request: Request,
  resource: DefinedPages<F>,
  keyOf: () => Promise<K>,
  operation: Operation<F, K>,
): Promise<Response> {
  try {
    const store = appRuntime().pageStoreOf(resource);
    const person = await currentPerson(request);
    if (person === null) {
      return problem('unauthenticated', 401, 'Sign in to Agent Workspace to use this app.');
    }
    return await operation(person, store, await keyOf());
  } catch (error) {
    return refusalOf(error);
  }
}

/** The page id of an item route's `[id]`; `resource_not_found` when it is not one. */
function pageKeyOf(context: ItemRouteContext): () => Promise<string> {
  return async () => {
    const { id } = await context.params;
    const key = typeof id === 'string' ? recordIdOf(id) : undefined;
    if (key === undefined) throw new AppStoreError('resource_not_found');
    return key;
  };
}

/** The parent a `children` request names: `null` (the top) when it names none. */
function parentOf(url: URL): string | null {
  const unknown = [...new Set(url.searchParams.keys())].filter((key) => key !== 'parent');
  const parents = url.searchParams.getAll('parent');
  if (unknown.length > 0 || parents.length > 1) {
    throw new AppStoreError('invalid_query', {
      details: [...(parents.length > 1 ? ['parent'] : []), ...unknown],
    });
  }
  const [raw] = parents;
  if (raw === undefined) return null;
  const parent = recordIdOf(raw);
  if (parent === undefined) throw new AppStoreError('invalid_query', { details: ['parent'] });
  return parent;
}

function pageOptionsOf(url: URL): { cursor?: string; limit?: number } {
  const repeated = ['cursor', 'limit'].filter((key) => url.searchParams.getAll(key).length > 1);
  const unknown = [...new Set(url.searchParams.keys())].filter(
    (key) => key !== 'cursor' && key !== 'limit',
  );
  if (repeated.length > 0 || unknown.length > 0) {
    throw new AppStoreError('invalid_query', { details: [...repeated, ...unknown] });
  }
  const cursor = url.searchParams.get('cursor');
  const limit = url.searchParams.get('limit');
  if (limit !== null && !LIMIT.test(limit)) throw new AppStoreError('invalid_limit');
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null ? {} : { limit: Number(limit) }),
  };
}

function restoreBodyOf(body: unknown): z.output<typeof RestoreBodySchema> {
  const parsed = RestoreBodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const details = [
    ...new Set(
      parsed.error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || '$'],
      ),
    ),
  ];
  throw new AppStoreError('invalid_body', { details });
}

/**
 * The page routes of `resource`.
 *
 * - `GET /api/<plural>/children?parent=<id>` answers `200 { items }`, the pages directly under
 *   `parent` (the top without it) that the person may read, lowest `position` first.
 * - `GET /api/<plural>/:id/revisions?cursor=&limit=` answers `200 { items, nextCursor }`, the
 *   page's revisions newest first, each with its author and the agent's `run_id` (or `null`).
 * - `POST /api/<plural>/:id/restore` with `{ revisionId, expectedRevisionId? }` writes that
 *   revision's title and blocks as a new revision: `200` and the page.
 * - `POST /api/<plural>/:id/move` with `{ parent, position }` (`parent: null` for the top):
 *   `200` and the page.
 *
 * | Status | Code                                                                                   |
 * | ------ | -------------------------------------------------------------------------------------- |
 * | 400    | `invalid_cursor`, `invalid_limit`, `invalid_query`, `invalid_body` (a `parent` that is no page among them), `malformed_body` |
 * | 401    | `unauthenticated`                                                                      |
 * | 403    | `forbidden` (the person, or the agent, may not change this page)                       |
 * | 404    | `resource_not_found`, `revision_not_found`                                             |
 * | 409    | `page_cycle`, `page_space_mismatch`, `page_conflict` (`expectedRevisionId` is stale)    |
 * | 413    | `request_body_too_large`                                                               |
 * | 415    | `unsupported_media_type`                                                               |
 * | 500    | `app_misconfigured`, `internal_error`                                                  |
 * | 502    | `upstream_failure`                                                                     |
 *
 * `resourceItemRoutes` of the same resource answers `409 page_has_children` for a `DELETE` of a
 * page with children, and `409 page_conflict` for a `PATCH` whose `expectedRevisionId` is stale.
 */
export function pageRoutes<F extends FieldMap>(resource: DefinedPages<F>): PageRoutes {
  return {
    children: {
      GET: (request) =>
        serve(
          request,
          resource,
          () => Promise.resolve(parentOf(new URL(request.url))),
          async (person, store, parent) =>
            json(200, { items: await store.children(person, parent) }),
        ),
    },
    revisions: {
      GET: (request, context) =>
        serve(request, resource, pageKeyOf(context), async (person, store, id) => {
          const page = await store.revisions(person, id, pageOptionsOf(new URL(request.url)));
          return json(200, { items: page.items, nextCursor: page.nextCursor });
        }),
    },
    restore: {
      POST: (request, context) =>
        serve(request, resource, pageKeyOf(context), async (person, store, id) => {
          const body = restoreBodyOf(await jsonBodyOf(request));
          const options =
            body.expectedRevisionId === undefined
              ? {}
              : { expectedRevisionId: body.expectedRevisionId };
          return json(200, await store.restore(person, id, body.revisionId, options));
        }),
    },
    move: {
      POST: (request, context) =>
        serve(request, resource, pageKeyOf(context), async (person, store, id) =>
          json(200, await store.move(person, id, await jsonBodyOf(request))),
        ),
    },
  };
}
