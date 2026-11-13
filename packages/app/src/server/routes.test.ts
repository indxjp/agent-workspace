import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enumOf, person, text } from '../fields/index.js';
import type { Person } from '../person.js';
import { defineResource } from '../resource.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { MAX_BODY_BYTES, resourceItemRoutes, resourceRoutes } from './routes.js';

const tickets = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 200 }),
    status: enumOf(['open', 'closed'], { default: 'open' }),
    assignee: person({ optional: true }),
  },
  access: {
    read: 'member',
    create: 'role:builder',
    update: ['role:admin', 'assignee'],
    delete: 'role:admin',
  },
  search: ['title'],
});

const notes = defineResource({
  name: 'note',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const BASE = 'https://app.test/api/tickets';

/** The platform's people: each token says who it is. */
const people = new Map<string, Person>();

function signIn(role: MembershipRoleName, workspaceId = FAKE_WORKSPACE_ID): string {
  const token = `awo_live_${crypto.randomUUID().replaceAll('-', '')}`;
  people.set(token, {
    principalId: crypto.randomUUID(),
    workspaceId,
    role,
    via: 'person',
  });
  return token;
}

function personOf(token: string): Person {
  const found = people.get(token);
  if (found === undefined) throw new Error('unknown token');
  return found;
}

const platform = fetchDouble((request) => {
  const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
  const found = people.get(token);
  if (found === undefined) {
    return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
  }
  return jsonResponse(200, {
    principalId: found.principalId,
    kind: 'membership',
    role: found.role,
    workspaceId: found.workspaceId,
    userId: crypto.randomUUID(),
    label: 'Someone',
    features: [],
  });
});

let runtime: TestAppRuntime;

beforeEach(() => {
  people.clear();
  // A clock a second apart per write, so "newest first" never rests on two records' random ids.
  let at = Date.parse('2026-10-01T00:00:00.000Z');
  runtime = setAppRuntimeForTests({
    fetch: platform.fetch,
    now: () => new Date((at += 1000)),
  });
});

afterEach(() => {
  resetAppRuntimeForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function request(
  method: string,
  url: string,
  options: { token?: string; body?: unknown; raw?: string; type?: string | null } = {},
): Request {
  const headers = new Headers();
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  const body =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined && options.type !== null) {
    headers.set('content-type', options.type ?? 'application/json');
  }
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** The problem of `response`, parsed with the contracts' one envelope; it must parse. */
async function problemOf(
  response: Response,
): Promise<{ status: number; code: string; details?: readonly string[] | undefined }> {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body: unknown = await response.json();
  const parsed = ApiProblemSchema.parse(body);
  expect(parsed.error).not.toHaveProperty('detail');
  return { status: response.status, code: parsed.error.code, details: parsed.error.details };
}

async function seed(token: string, title = 'Printer jam'): Promise<{ id: string }> {
  return runtime.storeOf(tickets).create(personOf(token), { title });
}

const collection = resourceRoutes(tickets);
const item = resourceItemRoutes(tickets);

describe('resourceRoutes GET', () => {
  it('lists newest first in the caller’s workspace, cursor-paged, with no-store', async () => {
    const builder = signIn('builder');
    for (const title of ['one', 'two', 'three']) await seed(builder, title);
    const first = await collection.GET(request('GET', `${BASE}?limit=2`, { token: builder }));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const page = (await first.json()) as { items: { title: string }[]; nextCursor: string };
    expect(page.items.map((record) => record.title)).toEqual(['three', 'two']);
    const second = await collection.GET(
      request('GET', `${BASE}?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`, {
        token: builder,
      }),
    );
    expect(await second.json()).toMatchObject({ items: [{ title: 'one' }], nextCursor: null });
  });

  it('filters by an enumOf() field and searches with q', async () => {
    const admin = signIn('admin');
    const closed = await seed(admin, 'Closed printer');
    await runtime.storeOf(tickets).update(personOf(admin), closed.id, { status: 'closed' });
    await seed(admin, 'Open laptop');
    const filtered = await collection.GET(
      request('GET', `${BASE}?status=closed`, { token: admin }),
    );
    expect(await filtered.json()).toMatchObject({ items: [{ title: 'Closed printer' }] });
    const searched = await collection.GET(request('GET', `${BASE}?q=laptop`, { token: admin }));
    expect(await searched.json()).toMatchObject({ items: [{ title: 'Open laptop' }] });
  });

  it.each([
    ['?cursor=nope', 400, 'invalid_cursor'],
    ['?limit=0', 400, 'invalid_limit'],
    ['?limit=ten', 400, 'invalid_limit'],
    ['?status=lost', 400, 'invalid_query'],
    ['?created_by=x', 400, 'invalid_query'],
    ['?status=open&status=closed', 400, 'invalid_query'],
    ['?q=printer&status=open', 400, 'invalid_query'],
    ['?q=', 400, 'invalid_query'],
  ])('GET %s answers %i %s', async (query, status, code) => {
    const response = await collection.GET(
      request('GET', `${BASE}${query}`, { token: signIn('viewer') }),
    );
    expect(await problemOf(response)).toMatchObject({ status, code });
  });

  it('answers 400 search_unsupported for q on a resource without search', async () => {
    const response = await resourceRoutes(notes).GET(
      request('GET', 'https://app.test/api/notes?q=x', { token: signIn('viewer') }),
    );
    expect(await problemOf(response)).toMatchObject({ status: 400, code: 'search_unsupported' });
  });

  it('answers 401 unauthenticated without a token and for a token the platform refuses', async () => {
    expect(await problemOf(await collection.GET(request('GET', BASE)))).toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    const refused = await collection.GET(request('GET', BASE, { token: 'awo_live_revoked' }));
    expect(await problemOf(refused)).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('answers 502 upstream_failure when the platform fails, without its text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setAppRuntimeForTests({
      fetch: () => Promise.resolve(new Response('db password leaked', { status: 500 })),
    });
    const response = await collection.GET(request('GET', BASE, { token: 'awo_live_x' }));
    const text = await response.clone().text();
    expect(await problemOf(response)).toMatchObject({ status: 502, code: 'upstream_failure' });
    expect(text).not.toContain('leaked');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('leaked');
  });

  it('answers 500 internal_error for a store failure, logging no text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(runtime.storeOf(tickets), 'list').mockRejectedValue(new Error('relation secret'));
    const response = await collection.GET(request('GET', BASE, { token: signIn('viewer') }));
    expect(await problemOf(response)).toMatchObject({ status: 500, code: 'internal_error' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
  });

  it('answers 500 app_misconfigured when the environment is incomplete', async () => {
    resetAppRuntimeForTests();
    vi.stubEnv('AW_URL', 'https://aw.test');
    vi.stubEnv('AW_APP_NAME', 'service-desk');
    vi.stubEnv('DATABASE_URL', '');
    const response = await collection.GET(request('GET', BASE, { token: signIn('viewer') }));
    expect(await problemOf(response)).toMatchObject({ status: 500, code: 'app_misconfigured' });
  });
});

describe('resourceRoutes POST', () => {
  it('creates a record as the person: 201 with location', async () => {
    const builder = signIn('builder');
    const response = await collection.POST(
      request('POST', BASE, { token: builder, body: { title: 'New laptop' } }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const record = (await response.json()) as { id: string; created_by: string };
    expect(response.headers.get('location')).toBe(`/api/tickets/${record.id}`);
    expect(record.created_by).toBe(personOf(builder).principalId);
  });

  it('refuses a Viewer where create is role:builder, and admits an Owner (monotonic)', async () => {
    const viewer = await collection.POST(
      request('POST', BASE, { token: signIn('viewer'), body: { title: 'x' } }),
    );
    expect(await problemOf(viewer)).toMatchObject({ status: 403, code: 'forbidden' });
    const owner = await collection.POST(
      request('POST', BASE, { token: signIn('owner'), body: { title: 'x' } }),
    );
    expect(owner.status).toBe(201);
  });

  it('answers 400 invalid_body for unknown keys, naming them', async () => {
    const response = await collection.POST(
      request('POST', BASE, { token: signIn('builder'), body: { title: 'x', priority: 1 } }),
    );
    expect(await problemOf(response)).toMatchObject({
      status: 400,
      code: 'invalid_body',
      details: ['priority'],
    });
  });

  it.each([
    ['not JSON', { raw: '{"title":', type: 'application/json' }, 400, 'malformed_body'],
    ['an empty body', { raw: '', type: 'application/json' }, 400, 'malformed_body'],
    ['text/plain', { raw: '{}', type: 'text/plain' }, 415, 'unsupported_media_type'],
    ['no content type', { raw: '{}', type: null }, 415, 'unsupported_media_type'],
    [
      'a body over 1 MiB',
      { raw: JSON.stringify({ title: 'x'.repeat(MAX_BODY_BYTES) }), type: 'application/json' },
      413,
      'request_body_too_large',
    ],
  ] as const)('answers %s with %i %s', async (_name, body, status, code) => {
    const response = await collection.POST(
      request('POST', BASE, { token: signIn('builder'), raw: body.raw, type: body.type }),
    );
    expect(await problemOf(response)).toMatchObject({ status, code });
  });

  it('answers 413 for a body that grows past 1 MiB while it streams, without a length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 8) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const streamed = new Request(BASE, {
      method: 'POST',
      headers: { authorization: `Bearer ${signIn('builder')}`, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await problemOf(await collection.POST(streamed))).toMatchObject({
      status: 413,
      code: 'request_body_too_large',
    });
    expect(sent).toBeLessThan(8);
  });

  it('answers 401 before reading the body', async () => {
    const response = await collection.POST(request('POST', BASE, { raw: 'not json' }));
    expect(await problemOf(response)).toMatchObject({ status: 401, code: 'unauthenticated' });
  });
});

describe('resourceItemRoutes', () => {
  it('GET answers 200 and the record', async () => {
    const viewer = signIn('viewer');
    const { id } = await seed(signIn('builder'));
    const response = await item.GET(request('GET', `${BASE}/${id}`, { token: viewer }), params(id));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ id, title: 'Printer jam' });
  });

  it('a resource in another workspace answers 404 resource_not_found', async () => {
    const { id } = await seed(signIn('owner', OTHER_WORKSPACE_ID));
    const owner = signIn('owner');
    for (const response of [
      await item.GET(request('GET', `${BASE}/${id}`, { token: owner }), params(id)),
      await item.PATCH(
        request('PATCH', `${BASE}/${id}`, { token: owner, body: { title: 'mine' } }),
        params(id),
      ),
      await item.DELETE(request('DELETE', `${BASE}/${id}`, { token: owner }), params(id)),
    ]) {
      expect(await problemOf(response)).toMatchObject({ status: 404, code: 'resource_not_found' });
    }
  });

  it('a member of a workspace the deployment does not serve is no person: 401, and nothing is written', async () => {
    const { id } = await seed(signIn('owner'));
    const stranger = signIn('owner', OTHER_WORKSPACE_ID);
    for (const response of [
      await collection.GET(request('GET', BASE, { token: stranger })),
      await collection.POST(request('POST', BASE, { token: stranger, body: { title: 'x' } })),
      await item.GET(request('GET', `${BASE}/${id}`, { token: stranger }), params(id)),
      await item.PATCH(
        request('PATCH', `${BASE}/${id}`, { token: stranger, body: { title: 'theirs' } }),
        params(id),
      ),
      await item.DELETE(request('DELETE', `${BASE}/${id}`, { token: stranger }), params(id)),
    ]) {
      expect(await problemOf(response)).toMatchObject({ status: 401, code: 'unauthenticated' });
    }
    const theirs = await runtime
      .storeOf(tickets)
      .list({ ...personOf(stranger), role: 'owner' }, { limit: 100 });
    expect(theirs.items).toEqual([]);
  });

  it('a non-UUID id answers 404 resource_not_found without reaching the store', async () => {
    const response = await item.GET(
      request('GET', `${BASE}/not-a-uuid`, { token: signIn('viewer') }),
      params('not-a-uuid'),
    );
    expect(await problemOf(response)).toMatchObject({ status: 404, code: 'resource_not_found' });
    expect(runtime.storeOf(tickets).calls.get).toBe(0);
  });

  it('PATCH answers 200 and the changed record for the assignee, 403 for another builder', async () => {
    const admin = signIn('admin');
    const assignee = signIn('builder');
    const { id } = await seed(admin);
    await runtime
      .storeOf(tickets)
      .update(personOf(admin), id, { assignee: personOf(assignee).principalId });
    const changed = await item.PATCH(
      request('PATCH', `${BASE}/${id}`, { token: assignee, body: { status: 'closed' } }),
      params(id),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ id, status: 'closed' });
    const refused = await item.PATCH(
      request('PATCH', `${BASE}/${id}`, { token: signIn('builder'), body: { status: 'open' } }),
      params(id),
    );
    expect(await problemOf(refused)).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it.each([
    ['malformed JSON', { raw: '{', type: 'application/json' }, 400, 'malformed_body'],
    ['an unknown key', { raw: '{"colour":"red"}', type: 'application/json' }, 400, 'invalid_body'],
    ['text/plain', { raw: '{}', type: 'text/plain' }, 415, 'unsupported_media_type'],
    [
      'over 1 MiB',
      { raw: `"${'x'.repeat(MAX_BODY_BYTES)}"`, type: 'application/json' },
      413,
      'request_body_too_large',
    ],
  ] as const)('PATCH with %s answers %i %s', async (_name, body, status, code) => {
    const admin = signIn('admin');
    const { id } = await seed(admin);
    const response = await item.PATCH(
      request('PATCH', `${BASE}/${id}`, { token: admin, raw: body.raw, type: body.type }),
      params(id),
    );
    expect(await problemOf(response)).toMatchObject({ status, code });
  });

  it('DELETE answers 204 for an admin', async () => {
    const admin = signIn('admin');
    const { id } = await seed(admin);
    const response = await item.DELETE(
      request('DELETE', `${BASE}/${id}`, { token: admin }),
      params(id),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('a member denied DELETE gets the problem code, not a raw message', async () => {
    const builder = signIn('builder');
    const { id } = await seed(builder);
    const response = await item.DELETE(
      request('DELETE', `${BASE}/${id}`, { token: builder }),
      params(id),
    );
    const body = (await response.clone().json()) as { error: { message: string } };
    expect(await problemOf(response)).toMatchObject({ status: 403, code: 'forbidden' });
    expect(body.error.message).toBe('You may not do this to this record.');
  });

  it.each(['GET', 'PATCH', 'DELETE'] as const)(
    '%s answers 401 unauthenticated without a person',
    async (method) => {
      const id = crypto.randomUUID();
      const response = await item[method](request(method, `${BASE}/${id}`), params(id));
      expect(await problemOf(response)).toMatchObject({ status: 401, code: 'unauthenticated' });
    },
  );

  it('answers 502 upstream_failure when the platform cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setAppRuntimeForTests({ fetch: () => Promise.reject(new TypeError('connect ECONNREFUSED')) });
    const id = crypto.randomUUID();
    const response = await item.GET(
      request('GET', `${BASE}/${id}`, { token: 'awu_live_x' }),
      params(id),
    );
    expect(await problemOf(response)).toMatchObject({ status: 502, code: 'upstream_failure' });
  });

  it('answers 500 internal_error when the store fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(runtime.storeOf(tickets), 'delete').mockRejectedValue(new Error('deadlock'));
    const id = crypto.randomUUID();
    const response = await item.DELETE(
      request('DELETE', `${BASE}/${id}`, { token: signIn('admin') }),
      params(id),
    );
    expect(await problemOf(response)).toMatchObject({ status: 500, code: 'internal_error' });
  });
});
