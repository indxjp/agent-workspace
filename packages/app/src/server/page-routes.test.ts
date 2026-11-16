import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PageRecord } from '../db/page-port.js';
import { definePages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { pageRoutes } from './page-routes.js';
import { resourceItemRoutes } from './routes.js';

const pages = definePages({
  access: { read: 'member', create: 'member', update: 'role:builder', delete: 'role:admin' },
});
const docs = definePages({
  name: 'doc',
  space: true,
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

const people = new Map<string, Person>();

function signIn(role: MembershipRoleName): string {
  const token = `awo_live_${crypto.randomUUID().replaceAll('-', '')}`;
  people.set(token, {
    principalId: crypto.randomUUID(),
    workspaceId: FAKE_WORKSPACE_ID,
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
  let at = Date.parse('2026-10-01T00:00:00.000Z');
  runtime = setAppRuntimeForTests({ fetch: platform.fetch, now: () => new Date((at += 1000)) });
});

afterEach(() => {
  resetAppRuntimeForTests();
});

function request(method: string, url: string, token?: string, body?: unknown): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function problemOf(response: Response): Promise<readonly [number, string]> {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const parsed = ApiProblemSchema.parse(await response.json());
  return [response.status, parsed.error.code];
}

const routes = pageRoutes(pages);
const BASE = 'https://app.test/api/pages';

async function seed(
  token: string,
  input: Record<string, unknown>,
): Promise<PageRecord<typeof pages.fields>> {
  return runtime.pageStoreOf(pages).create(personOf(token), input);
}

describe('pageRoutes', () => {
  it('lists the pages under a parent, and the top without one (#1521)', async () => {
    const builder = signIn('builder');
    const top = await seed(builder, { title: 'Handbook' });
    await seed(builder, { title: 'Printers', parent: top.id });
    await seed(builder, { title: 'Scanners', parent: top.id });
    const children = (query: string, token = builder): Promise<Response> =>
      routes.children.GET(request('GET', `${BASE}/children${query}`, token));
    const roots = await children('');
    expect(roots.status).toBe(200);
    expect(roots.headers.get('cache-control')).toBe('no-store');
    expect(await roots.json()).toMatchObject({ items: [{ id: top.id, title: 'Handbook' }] });
    const under = (await (await children(`?parent=${top.id}`)).json()) as {
      items: { title: string; revision_id: string }[];
    };
    expect(under.items.map((item) => item.title)).toEqual(['Printers', 'Scanners']);
    expect(under.items.every((item) => typeof item.revision_id === 'string')).toBe(true);
    expect(await problemOf(await children('?parent=nope'))).toEqual([400, 'invalid_query']);
    expect(await problemOf(await children(`?parent=${top.id}&parent=${top.id}`))).toEqual([
      400,
      'invalid_query',
    ]);
    expect(await problemOf(await children('?q=x'))).toEqual([400, 'invalid_query']);
    expect(await problemOf(await children('', 'not-a-token'))).toEqual([401, 'unauthenticated']);
  });

  it('lists a page’s revisions newest first, cursor-paged', async () => {
    const builder = signIn('builder');
    const page = await seed(builder, { title: 'v1' });
    await runtime.pageStoreOf(pages).update(personOf(builder), page.id, { title: 'v2' });
    const url = `${BASE}/${page.id}/revisions?limit=1`;
    const first = await routes.revisions.GET(request('GET', url, builder), params(page.id));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { items: { title: string }[]; nextCursor: string };
    expect(body.items.map((item) => item.title)).toEqual(['v2']);
    const next = await routes.revisions.GET(
      request('GET', `${url}&cursor=${body.nextCursor}`, builder),
      params(page.id),
    );
    expect(await next.json()).toMatchObject({ items: [{ title: 'v1' }], nextCursor: null });
  });

  it('restores a revision as a new one, and answers each refusal by code', async () => {
    const builder = signIn('builder');
    const page = await seed(builder, { title: 'v1' });
    const edited = await runtime.pageStoreOf(pages).update(personOf(builder), page.id, {
      title: 'v2',
    });
    const restore = (body: unknown, token = builder): Promise<Response> =>
      routes.restore.POST(
        request('POST', `${BASE}/${page.id}/restore`, token, body),
        params(page.id),
      );
    const stale = await restore({
      revisionId: page.revision_id,
      expectedRevisionId: page.revision_id,
    });
    expect(await problemOf(stale)).toEqual([409, 'page_conflict']);
    const restored = await restore({
      revisionId: page.revision_id,
      expectedRevisionId: edited.revision_id,
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ title: 'v1' });
    expect(await problemOf(await restore({ revisionId: crypto.randomUUID() }))).toEqual([
      404,
      'revision_not_found',
    ]);
    expect(await problemOf(await restore({ revision: page.revision_id }))).toEqual([
      400,
      'invalid_body',
    ]);
    expect(
      await problemOf(await restore({ revisionId: page.revision_id }, signIn('viewer'))),
    ).toEqual([403, 'forbidden']);
  });

  it('moves a page, refusing a cycle and a parent that is no page', async () => {
    const builder = signIn('builder');
    const top = await seed(builder, { title: 'Top' });
    const below = await seed(builder, { title: 'Below', parent: top.id });
    const move = (id: string, body: unknown): Promise<Response> =>
      routes.move.POST(request('POST', `${BASE}/${id}/move`, builder, body), params(id));
    expect(await problemOf(await move(top.id, { parent: below.id, position: 0 }))).toEqual([
      409,
      'page_cycle',
    ]);
    expect(
      await problemOf(await move(top.id, { parent: crypto.randomUUID(), position: 0 })),
    ).toEqual([400, 'invalid_body']);
    const moved = await move(below.id, { parent: null, position: 4 });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ parent: null, position: 4 });
  });

  it('refuses a move across spaces: 409 page_space_mismatch', async () => {
    const builder = signIn('builder');
    const store = runtime.pageStoreOf(docs);
    const red = await store.create(personOf(builder), { title: 'Red', space: crypto.randomUUID() });
    const blue = await store.create(personOf(builder), {
      title: 'Blue',
      space: crypto.randomUUID(),
    });
    const response = await pageRoutes(docs).move.POST(
      request('POST', `${BASE}/${blue.id}/move`, builder, { parent: red.id, position: 0 }),
      params(blue.id),
    );
    expect(await problemOf(response)).toEqual([409, 'page_space_mismatch']);
  });

  it('answers 401 without a person, 404 for an id that is no page, 400 for a bad query', async () => {
    const builder = signIn('builder');
    const page = await seed(builder, { title: 'Here' });
    const url = `${BASE}/${page.id}/revisions`;
    expect(
      await problemOf(await routes.revisions.GET(request('GET', url), params(page.id))),
    ).toEqual([401, 'unauthenticated']);
    expect(
      await problemOf(await routes.revisions.GET(request('GET', url, builder), params('nope'))),
    ).toEqual([404, 'resource_not_found']);
    expect(
      await problemOf(
        await routes.revisions.GET(request('GET', `${url}?limit=x`, builder), params(page.id)),
      ),
    ).toEqual([400, 'invalid_limit']);
    expect(
      await problemOf(
        await routes.revisions.GET(request('GET', `${url}?sort=asc`, builder), params(page.id)),
      ),
    ).toEqual([400, 'invalid_query']);
  });
});

describe('resourceItemRoutes of a page resource', () => {
  const item = resourceItemRoutes(pages);

  it('answers 409 page_has_children for a delete, and page_conflict for a stale PATCH', async () => {
    const builder = signIn('builder');
    const admin = signIn('admin');
    const top = await seed(builder, { title: 'Top' });
    await seed(builder, { title: 'Child', parent: top.id });
    const deleted = await item.DELETE(
      request('DELETE', `${BASE}/${top.id}`, admin),
      params(top.id),
    );
    expect(await problemOf(deleted)).toEqual([409, 'page_has_children']);
    const patch = (body: unknown): Promise<Response> =>
      item.PATCH(request('PATCH', `${BASE}/${top.id}`, builder, body), params(top.id));
    expect((await patch({ title: 'Top!', expectedRevisionId: top.revision_id })).status).toBe(200);
    expect(
      await problemOf(await patch({ title: 'Mine', expectedRevisionId: top.revision_id })),
    ).toEqual([409, 'page_conflict']);
    const revisions = await runtime.pageStoreOf(pages).revisions(personOf(builder), top.id);
    expect(revisions.items.map((revision) => revision.title)).toEqual(['Top!', 'Top']);
  });
});
