import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { enumOf, person, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import { resourceClient, ResourceProblemError } from './client.js';

const ticket = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 200 }),
    status: enumOf(['new', 'in_progress', 'resolved', 'closed'], { default: 'new' }),
    assignee: person({ optional: true }),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
});

const ID = '0f5c2a8e-1b2c-4d3e-8f90-123456789abc';
const PERSON = 'a1b2c3d4-0000-4000-8000-000000000001';
const WORKSPACE = 'b1b2c3d4-0000-4000-8000-000000000002';
const NOW = '2026-10-31T09:00:00Z';

const RECORD = {
  id: ID,
  workspace_id: WORKSPACE,
  created_at: NOW,
  updated_at: NOW,
  created_by: PERSON,
  updated_by: PERSON,
  title: 'Printer jam',
  status: 'new',
  assignee: null,
};

const BASE = 'https://app.example.test';

async function failure(promise: Promise<unknown>): Promise<ResourceProblemError> {
  const error: unknown = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ResourceProblemError);
  return error as ResourceProblemError;
}

describe('resourceClient (#1508)', () => {
  it('lists a page with the cursor and filters, parsed with the record schema', async () => {
    const double = fetchDouble(() => jsonResponse(200, { items: [RECORD], nextCursor: 'c2' }));
    const client = resourceClient(ticket, { baseUrl: `${BASE}/`, fetch: double.fetch });
    const page = await client.list({ cursor: 'c1', limit: 20, filters: { status: 'new' } });
    expect(page).toEqual({ items: [RECORD], nextCursor: 'c2' });
    expectTypeOf(page.items[0]?.status).toEqualTypeOf<
      'new' | 'in_progress' | 'resolved' | 'closed' | undefined
    >();
    const [call] = double.calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toBe('/api/tickets');
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      status: 'new',
      cursor: 'c1',
      limit: '20',
    });
    expect(call?.init.credentials).toBe('same-origin');
  });

  it('gets, creates and updates at the item and collection paths', async () => {
    const double = fetchDouble((request) =>
      jsonResponse(request.method === 'POST' ? 201 : 200, RECORD),
    );
    const client = resourceClient(ticket, { baseUrl: BASE, fetch: double.fetch });
    await expect(client.get(ID)).resolves.toEqual(RECORD);
    await expect(client.create({ title: 'Printer jam' })).resolves.toEqual(RECORD);
    await expect(client.update(ID, { assignee: null })).resolves.toEqual(RECORD);
    expect(double.calls.map((call) => [call.method, call.url.pathname, call.json])).toEqual([
      ['GET', `/api/tickets/${ID}`, undefined],
      ['POST', '/api/tickets', { title: 'Printer jam' }],
      ['PATCH', `/api/tickets/${ID}`, { assignee: null }],
    ]);
    expect(double.calls[1]?.headers.get('content-type')).toBe('application/json');
  });

  it('throws a typed error for a 404 problem', async () => {
    const double = fetchDouble(() =>
      jsonResponse(404, { error: { code: 'resource_not_found', message: 'No such ticket.' } }),
    );
    const error = await failure(
      resourceClient(ticket, { baseUrl: BASE, fetch: double.fetch }).get(ID),
    );
    expect(error).toMatchObject({
      code: 'resource_not_found',
      status: 404,
      message: 'No such ticket.',
      fieldErrors: {},
      formErrors: [],
    });
  });

  it.each([400, 422])('places the details of a %i invalid_body on the fields', async (status) => {
    const double = fetchDouble(() =>
      jsonResponse(status, {
        error: {
          code: 'invalid_body',
          message: 'The body is not a valid ticket.',
          details: ['title: Too long', 'status', 'unknown_key'],
        },
      }),
    );
    const client = resourceClient(ticket, { baseUrl: BASE, fetch: double.fetch });
    const error = await failure(client.create({ title: 'x' }));
    expect(error.code).toBe('invalid_body');
    expect(error.status).toBe(status);
    expect(error.fieldErrors).toEqual({ title: ['Too long'], status: [''] });
    expect(error.formErrors).toEqual(['unknown_key']);
  });

  it('throws a typed error, never a value, for a malformed body', async () => {
    const wrongShape = fetchDouble(() => jsonResponse(200, { ...RECORD, status: 'archived' }));
    const violation = await failure(
      resourceClient(ticket, { baseUrl: BASE, fetch: wrongShape.fetch }).get(ID),
    );
    expect(violation).toMatchObject({ code: 'contract_violation', status: 200 });

    const notJson = fetchDouble(() => new Response('<html>', { status: 200 }));
    expect(
      await failure(resourceClient(ticket, { baseUrl: BASE, fetch: notJson.fetch }).list()),
    ).toMatchObject({ code: 'contract_violation' });

    const noEnvelope = fetchDouble(() => jsonResponse(500, { oops: true }));
    expect(
      await failure(resourceClient(ticket, { baseUrl: BASE, fetch: noEnvelope.fetch }).get(ID)),
    ).toMatchObject({ code: 'unrecognised_error_body', status: 500 });
  });

  it('turns no answer into transport_failed', async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await failure(resourceClient(ticket, { baseUrl: BASE, fetch: offline }).list());
    expect(error).toMatchObject({ code: 'transport_failed', status: 0 });
  });

  it("calls the page's own origin when no base URL is given", async () => {
    const seen: string[] = [];
    const recording: typeof fetch = (input) => {
      seen.push(typeof input === 'string' ? input : 'not a path string');
      return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }));
    };
    await resourceClient(ticket, { fetch: recording }).list();
    expect(seen).toEqual(['/api/tickets']);
  });
});
