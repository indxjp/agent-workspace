/**
 * The generated routes of a resource (F-10, issue #1503): `GET`/`POST /api/<plural>` and
 * `GET`/`PATCH`/`DELETE /api/<plural>/:id`, as Next.js route handlers on Web `Request` and
 * `Response`. A generated route file imports the resource and this module and is one line more:
 * `export const { GET, POST } = resourceRoutes(ticket);` in `app/api/tickets/route.ts`, and
 * `export const { GET, PATCH, DELETE } = resourceItemRoutes(ticket);` in
 * `app/api/tickets/[id]/route.ts`.
 *
 * Every handler asks Agent Workspace who the person is ({@link currentPerson}) and runs the store
 * operation as them, so the resource's access rules decide; a route never checks access itself and
 * never writes SQL. Every answer carries `cache-control: no-store`; every failure is the one
 * problem envelope (ADR-0075).
 *
 * `{ publish: <channel> }` binds the resource to a `channel()` (issue #1519, `aw generate
 * channel`): every write of the resource, through these routes or an agent tool, publishes on it
 * in the write's transaction (`channel-bindings.ts`).
 */
import { AppStoreError } from '../db/errors.js';
import { recordIdOf } from '../db/policy.js';
import type { ListOptions, ResourceStore } from '../db/port.js';
import type { Person } from '../person.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import { bindChannel } from './channel-bindings.js';
import type { Channel } from './channel.js';
import { currentPerson } from './person.js';
import { NO_STORE, problem, problemFromError } from './problem.js';
import { appRuntime } from './runtime.js';

/** The largest body a write accepts: 1 MiB. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** A collection handler: `GET` or `POST /api/<plural>`. */
export type CollectionHandler = (request: Request) => Promise<Response>;

/** What Next.js 16 passes a dynamic route's handler besides the request. */
export interface ItemRouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

/** An item handler: `GET`, `PATCH` or `DELETE /api/<plural>/:id`. */
export type ItemHandler = (request: Request, context: ItemRouteContext) => Promise<Response>;

/** The handlers of `app/api/<plural>/route.ts`. */
export interface ResourceRoutes {
  readonly GET: CollectionHandler;
  readonly POST: CollectionHandler;
}

/** The handlers of `app/api/<plural>/[id]/route.ts`. */
export interface ResourceItemRoutes {
  readonly GET: ItemHandler;
  readonly PATCH: ItemHandler;
  readonly DELETE: ItemHandler;
}

/** What {@link resourceRoutes} and {@link resourceItemRoutes} may be told. */
export interface ResourceRouteOptions {
  /** The channel every write of the resource publishes on, in the write's transaction. */
  readonly publish?: Channel;
}

/** Binds `options.publish`, when given, to `resource`. */
function bindPublish(resource: DefinedResource, options: ResourceRouteOptions): void {
  if (options.publish !== undefined) bindChannel(resource, options.publish);
}

/** A request the route refuses before the store sees it; the agent panel's routes raise it too. */
export class RequestRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: readonly string[],
  ) {
    super(message);
    this.name = 'RequestRefusal';
  }
}

const RESERVED_QUERY_KEYS = new Set(['cursor', 'limit', 'q']);
const LIMIT = /^[0-9]{1,6}$/u;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': NO_STORE, ...headers } });
}

/** The problem answer of a {@link RequestRefusal}, or of anything else a handler threw. */
export function refusalOf(error: unknown): Response {
  if (error instanceof RequestRefusal) {
    return problem(error.code, error.status, error.message, error.details);
  }
  return problemFromError(error);
}

type Operation<F extends FieldMap> = (person: Person, store: ResourceStore<F>) => Promise<Response>;

/** Resolves the person and the store, runs `operation`, and renders whatever it throws. */
async function serve<F extends FieldMap>(
  request: Request,
  resource: DefinedResource<F>,
  operation: Operation<F>,
): Promise<Response> {
  try {
    const store = appRuntime().storeOf(resource);
    const person = await currentPerson(request);
    if (person === null) {
      return problem('unauthenticated', 401, 'Sign in to Agent Workspace to use this app.');
    }
    return await operation(person, store);
  } catch (error) {
    return refusalOf(error);
  }
}

/** The list or search a collection `GET` asks for. */
interface ListRequest {
  readonly q?: string;
  readonly options: ListOptions;
}

function listRequestOf(url: URL): ListRequest {
  const repeated = [...new Set(url.searchParams.keys())].filter(
    (key) => url.searchParams.getAll(key).length > 1,
  );
  if (repeated.length > 0) {
    throw new AppStoreError('invalid_query', {
      details: repeated.map((key) => (RESERVED_QUERY_KEYS.has(key) ? key : `where.${key}`)),
    });
  }
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && !LIMIT.test(rawLimit)) throw new AppStoreError('invalid_limit');
  const where = Object.fromEntries(
    [...url.searchParams].filter(([key]) => !RESERVED_QUERY_KEYS.has(key)),
  );
  const q = url.searchParams.get('q') ?? undefined;
  if (q !== undefined && Object.keys(where).length > 0) {
    throw new AppStoreError('invalid_query', {
      details: Object.keys(where).map((key) => `where.${key}`),
    });
  }
  return {
    ...(q === undefined ? {} : { q }),
    options: {
      ...(cursor === undefined ? {} : { cursor }),
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
      ...(Object.keys(where).length === 0 ? {} : { where }),
    },
  };
}

function tooLarge(): RequestRefusal {
  return new RequestRefusal(
    'request_body_too_large',
    413,
    'The request body is larger than 1 MiB.',
  );
}

/**
 * The text of `request`'s body, refused (`413 request_body_too_large`) as soon as it passes
 * {@link MAX_BODY_BYTES}; the recipe webhook reads its raw body with it too.
 */
export async function boundedText(request: Request): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw tooLarge();
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * The JSON body of a write: `application/json`, at most 1 MiB, and parseable. Its shape is the
 * store's to check (`invalid_body`).
 */
export async function jsonBodyOf(request: Request): Promise<unknown> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new RequestRefusal(
      'unsupported_media_type',
      415,
      'The request body must be application/json.',
    );
  }
  const text = await boundedText(request).catch((error: unknown) => {
    if (error instanceof RequestRefusal) throw error;
    throw new RequestRefusal('malformed_body', 400, 'The request body is not valid JSON.');
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestRefusal('malformed_body', 400, 'The request body is not valid JSON.');
  }
}

async function recordIdFrom(context: ItemRouteContext): Promise<string> {
  const { id } = await context.params;
  const key = typeof id === 'string' ? recordIdOf(id) : undefined;
  if (key === undefined) throw new AppStoreError('resource_not_found');
  return key;
}

/**
 * The collection handlers of `resource`, for `app/api/<plural>/route.ts`.
 *
 * - `GET ?cursor=&limit=&<enumField>=<value>` lists newest first; `GET ?q=<text>` searches the
 *   resource's `search` fields. Both answer `200 { items, nextCursor }`.
 * - `POST` with a JSON body creates a record: `201`, the record, and `location: /api/<plural>/<id>`.
 *
 * | Status | Code                                                                                      |
 * | ------ | ----------------------------------------------------------------------------------------- |
 * | 400    | `invalid_cursor`, `invalid_limit`, `invalid_query`, `invalid_body`, `malformed_body`, `search_unsupported` |
 * | 401    | `unauthenticated` (no person's token, or the platform refused it)                         |
 * | 403    | `forbidden` (the person may not create this record)                                       |
 * | 413    | `request_body_too_large` (over 1 MiB)                                                     |
 * | 415    | `unsupported_media_type` (the body is not `application/json`)                             |
 * | 500    | `app_misconfigured`, `internal_error`                                                     |
 * | 502    | `upstream_failure` (Agent Workspace did not say who is asking)                            |
 */
export function resourceRoutes<F extends FieldMap>(
  resource: DefinedResource<F>,
  options: ResourceRouteOptions = {},
): ResourceRoutes {
  bindPublish(resource, options);
  return {
    GET: (request) =>
      serve(request, resource, async (person, store) => {
        const { q, options } = listRequestOf(new URL(request.url));
        const page =
          q === undefined
            ? await store.list(person, options)
            : await store.search(person, q, options);
        return json(200, { items: page.items, nextCursor: page.nextCursor });
      }),
    POST: (request) =>
      serve(request, resource, async (person, store) => {
        const record = await store.create(person, await jsonBodyOf(request));
        const collection = new URL(request.url).pathname.replace(/\/+$/u, '');
        return json(201, record, { location: `${collection}/${encodeURIComponent(record.id)}` });
      }),
  };
}

/**
 * The item handlers of `resource`, for `app/api/<plural>/[id]/route.ts`, with Next.js 16's
 * `params` promise. `GET` answers `200` and the record, `PATCH` (a JSON body of the fields to
 * change) `200` and the changed record, `DELETE` `204`.
 *
 * A record in another workspace, one the person may not read, and an id that is not a UUID all
 * answer `404 resource_not_found`, so a caller learns nothing of records they cannot see.
 *
 * | Status | Code                                                                       |
 * | ------ | -------------------------------------------------------------------------- |
 * | 400    | `invalid_body`, `malformed_body`                                           |
 * | 401    | `unauthenticated`                                                          |
 * | 403    | `forbidden` (the person may read the record but not make this change)      |
 * | 404    | `resource_not_found`                                                       |
 * | 413    | `request_body_too_large`                                                   |
 * | 415    | `unsupported_media_type`                                                   |
 * | 500    | `app_misconfigured`, `internal_error`                                      |
 * | 502    | `upstream_failure`                                                         |
 */
export function resourceItemRoutes<F extends FieldMap>(
  resource: DefinedResource<F>,
  options: ResourceRouteOptions = {},
): ResourceItemRoutes {
  bindPublish(resource, options);
  return {
    GET: (request, context) =>
      serve(request, resource, async (person, store) =>
        json(200, await store.get(person, await recordIdFrom(context))),
      ),
    PATCH: (request, context) =>
      serve(request, resource, async (person, store) => {
        const id = await recordIdFrom(context);
        return json(200, await store.update(person, id, await jsonBodyOf(request)));
      }),
    DELETE: (request, context) =>
      serve(request, resource, async (person, store) => {
        await store.delete(person, await recordIdFrom(context));
        return new Response(null, { status: 204, headers: { 'cache-control': NO_STORE } });
      }),
  };
}
