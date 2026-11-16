/**
 * `resourceClient`: the browser's way to a resource's generated routes (`/api/<plural>` and
 * `/api/<plural>/:id`, issue #1503), so a page part never calls `fetch` itself (issue #1508).
 *
 * The shape is the SDK's (`packages/sdk/src/http.ts`): send, then parse every answer with a
 * schema, and throw one typed error otherwise. A success body is parsed with the resource's own
 * record schema; a failure body with the ADR-0075 problem envelope from the contracts. A caller
 * sees a value the schema accepted or a {@link ResourceProblemError}, never `any`.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { z } from 'zod';

import type { DefinedResource, FieldMap } from '../resource.js';
import { recordSchema, type CreateInput, type RecordOf, type UpdateInput } from '../schemas.js';
import { placeProblemDetails } from './resource-view-model.js';

/** Where the routes are and how to reach them. */
export interface ResourceClientOptions {
  /** The app's origin and path prefix; `''` (the page's own origin) when not given. */
  readonly baseUrl?: string;
  /** Injected for tests; the global `fetch` when not given. */
  readonly fetch?: typeof fetch;
}

/** One page of a list: the records and the cursor of the next page (`null` on the last). */
export interface ResourcePage<R> {
  readonly items: readonly R[];
  readonly nextCursor: string | null;
}

/** What a list asks for: the page after `cursor`, and the filters (`<field>=<value>`). */
export interface ResourceListQuery {
  readonly cursor?: string | null | undefined;
  readonly limit?: number | undefined;
  readonly filters?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A resource's routes, typed by its fields. */
export interface ResourceClient<F extends FieldMap = FieldMap> {
  list(query?: ResourceListQuery): Promise<ResourcePage<RecordOf<F>>>;
  get(id: string, options?: { readonly signal?: AbortSignal }): Promise<RecordOf<F>>;
  create(body: CreateInput<F>): Promise<RecordOf<F>>;
  update(id: string, patch: UpdateInput<F>): Promise<RecordOf<F>>;
}

/** The codes this client gives a failure that is not a problem the server answered with. */
export type ResourceClientCode =
  'transport_failed' | 'unrecognised_error_body' | 'contract_violation';

/**
 * A request that did not answer with what the route promises: a problem envelope the server sent
 * (`code` and `status` are its own), no answer at all (`transport_failed`, status `0`), a failure
 * without the envelope (`unrecognised_error_body`), or a success the record schema refused
 * (`contract_violation`). `fieldErrors` holds the envelope's `details` lines that name a field of
 * the resource, by field; `formErrors` the rest.
 */
export class ResourceProblemError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
  public readonly formErrors: readonly string[];

  public constructor(init: {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
    readonly formErrors?: readonly string[];
  }) {
    super(init.message);
    this.name = 'ResourceProblemError';
    this.code = init.code;
    this.status = init.status;
    this.fieldErrors = init.fieldErrors ?? {};
    this.formErrors = init.formErrors ?? [];
  }
}

const CursorSchema = z.string().min(1).nullable();

/** The problem a failed answer carries, placed onto the resource's fields. */
async function problemOf(
  resource: DefinedResource,
  response: Response,
): Promise<ResourceProblemError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ApiProblemSchema.safeParse(body);
  if (!parsed.success) {
    return new ResourceProblemError({
      code: 'unrecognised_error_body',
      status: response.status,
      message: `the app answered ${String(response.status)} without the problem envelope`,
    });
  }
  const { code, message, details } = parsed.data.error;
  const placement = placeProblemDetails(resource, details);
  return new ResourceProblemError({
    code,
    status: response.status,
    message,
    fieldErrors: placement.fields,
    formErrors: placement.form,
  });
}

/** One request of a resource's routes: what to send, and the status and schema of its answer. */
interface ResourceRequest<S extends z.ZodType> {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  readonly expect: number;
  readonly schema: S;
  readonly signal?: AbortSignal | undefined;
}

/** Sends one request of a resource's routes and parses its answer. */
export type ResourceRequester = <S extends z.ZodType>(
  spec: ResourceRequest<S>,
) => Promise<z.output<S>>;

/** The path of a resource's collection route, and of one record's. */
export interface ResourcePaths {
  readonly collection: string;
  readonly item: (id: string) => string;
}

/** The paths of `resource`'s generated routes. */
export function resourcePaths(resource: DefinedResource): ResourcePaths {
  const collection = `/api/${encodeURIComponent(resource.plural)}`;
  return { collection, item: (id) => `${collection}/${encodeURIComponent(id)}` };
}

/**
 * The sender of `resource`'s requests, which `resourceClient` and `pageClient` share: a success is
 * parsed with the request's schema, a failure as the problem envelope placed onto the fields.
 */
export function resourceRequester(
  resource: DefinedResource,
  options: ResourceClientOptions = {},
): ResourceRequester {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/u, '');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async function request<S extends z.ZodType>(
    spec: ResourceRequest<S>,
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await send(`${baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        credentials: 'same-origin',
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      });
    } catch {
      throw new ResourceProblemError({
        code: 'transport_failed',
        status: 0,
        message: `${spec.method} ${spec.path} got no answer`,
      });
    }
    if (response.status !== spec.expect) throw await problemOf(resource, response);
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = spec.schema.safeParse(body);
    if (!parsed.success) {
      throw new ResourceProblemError({
        code: 'contract_violation',
        status: response.status,
        message: `${spec.method} ${spec.path} answered a body the ${resource.name} schema refuses`,
      });
    }
    return parsed.data;
  };
}

/**
 * Builds the client of `resource`'s routes. Every answer is parsed: a success with the record
 * schema (a list as `{ items, nextCursor }`), a failure as a problem.
 */
export function resourceClient<F extends FieldMap>(
  resource: DefinedResource<F>,
  options: ResourceClientOptions = {},
): ResourceClient<F> {
  const request = resourceRequester(resource, options);
  const record = recordSchema(resource);
  const page = z.strictObject({ items: z.array(record), nextCursor: CursorSchema });
  const { collection, item } = resourcePaths(resource);

  return {
    async list(query = {}) {
      const search = new URLSearchParams(query.filters ?? {});
      if (query.cursor !== undefined && query.cursor !== null) search.set('cursor', query.cursor);
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      const suffix = search.size === 0 ? '' : `?${search.toString()}`;
      return request({
        method: 'GET',
        path: `${collection}${suffix}`,
        expect: 200,
        schema: page,
        signal: query.signal,
      });
    },
    async get(id, getOptions) {
      return request({
        method: 'GET',
        path: item(id),
        expect: 200,
        schema: record,
        signal: getOptions?.signal,
      });
    },
    async create(body) {
      return request({ method: 'POST', path: collection, body, expect: 201, schema: record });
    },
    async update(id, patch) {
      return request({ method: 'PATCH', path: item(id), body: patch, expect: 200, schema: record });
    },
  };
}
