/** Route discovery, dispatch and Owner-key HTTP seeding for the API-key inventory. */
import crypto from 'node:crypto';
import { API_ROUTES, type ApiRoute } from '@indx-workspace/contracts/routes';
import { NextRequest } from 'next/server';
import { proxy } from '../../proxy';
import { acceptsApiKey } from '../auth/api-key-routes';

export const KEY_ROUTES = API_ROUTES.filter(acceptsApiKey);

const ORIGIN = 'http://127.0.0.1:3000';

const PASSED_THROUGH = 'x-middleware-next';

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** Every route module in the tree, keyed `../../app/api/<…>/route.ts`. */
export const ROUTE_MODULES = import.meta.glob('../../app/api/**/route.ts');

export function moduleKey(pattern: string): string {
  return `../../app${pattern.replace(/:([A-Za-z]+)/gu, '[$1]')}/route.ts`;
}

export function label(route: ApiRoute): string {
  return `${route.method} ${route.path}`;
}

/** A run of the seeded agent, owned by the Owner key's principal, for `POST /api/tokens`. */
export const SEEDED_RUN_ID = crypto.randomUUID();

/** The file the Owner key uploads, and the id its item routes address it by. */
export const SEEDED_FILE_PATH = 'inventory.txt';

/**
 * A well-formed body for the routes that parse theirs before the role decision, so a probe reaches
 * the decision rather than a `400` about its body. Every other unsafe probe sends `{}`.
 */
const PROBE_BODIES: Readonly<Record<string, unknown>> = {
  // Ownership is derived from the scope named in the body, so it is read first (issue #236).
  // The run the Owner key's principal owns is seeded below, and read back when the probe runs.
  'POST /api/tokens': { scope: { kind: 'run', id: SEEDED_RUN_ID } },
  'PATCH /api/projects/:id': { name: 'Renamed by the inventory' },
};

export async function serve(route: ApiRoute, concrete: string, apiKey: string): Promise<Response> {
  const unsafe = route.method !== 'GET';
  const request = new NextRequest(new URL(concrete, ORIGIN), {
    method: route.method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(unsafe ? { 'content-type': 'application/json' } : {}),
    },
    ...(unsafe ? { body: JSON.stringify(PROBE_BODIES[label(route)] ?? {}) } : {}),
  });
  const gated = await proxy(request);
  if (gated.headers.get(PASSED_THROUGH) !== '1') return gated;
  const load = ROUTE_MODULES[moduleKey(route.path)];
  if (load === undefined) throw new Error(`no route module for ${label(route)}`);
  const module = (await load()) as Record<string, unknown>;
  const handler = module[route.method];
  if (typeof handler !== 'function') throw new Error(`${label(route)} exports no handler`);
  const params: Record<string, string> = {};
  const patternSegments = route.path.split('/');
  const concreteSegments = new URL(concrete, ORIGIN).pathname.split('/');
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(':')) params[segment.slice(1)] = concreteSegments[index] ?? '';
  });
  return (handler as RouteHandler)(request, { params: Promise.resolve(params) });
}

export async function ownerCreates(
  ownerKey: string,
  collection: string,
  body: unknown,
): Promise<string> {
  const route = KEY_ROUTES.find((each) => each.method === 'POST' && each.path === collection);
  if (route === undefined) throw new Error(`${collection} has no key-accessible POST`);
  const request = new NextRequest(new URL(collection, ORIGIN), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ownerKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const load = ROUTE_MODULES[moduleKey(collection)];
  if (load === undefined) throw new Error(`no route module for POST ${collection}`);
  const handler = ((await load()) as Record<string, RouteHandler>)['POST'];
  if (handler === undefined) throw new Error(`POST ${collection} has no handler`);
  const response = await handler(request, { params: Promise.resolve({}) });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`seeding ${collection} answered ${String(response.status)}: ${text}`);
  }
  const created = JSON.parse(text) as Record<string, unknown>;
  const resource = Object.values(created).find(
    (value): value is { id: string } =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string',
  );
  const id = typeof created['id'] === 'string' ? created['id'] : resource?.id;
  if (id === undefined) throw new Error(`seeding ${collection} returned no id: ${text}`);
  return id;
}

export async function seedFile(ownerKey: string) {
  const uploadModule = (await ROUTE_MODULES[moduleKey('/api/files')]?.()) as
    Record<string, RouteHandler> | undefined;
  const upload = await uploadModule?.['POST']?.(
    new NextRequest(new URL('/api/files', ORIGIN), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerKey}`,
        'content-type': 'text/plain',
        'x-file-path': SEEDED_FILE_PATH,
      },
      body: 'seeded by the API-key route inventory',
    }),
    { params: Promise.resolve({}) },
  );
  if (upload?.status !== 201) {
    throw new Error(`seeding a file answered ${String(upload?.status)}: ${await upload?.text()}`);
  }
}
