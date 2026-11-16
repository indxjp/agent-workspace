import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { WebhooksClient } from './webhooks.js';

const WEBHOOK_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = `whsec_${'A'.repeat(43)}=`;

const webhook = {
  id: WEBHOOK_ID,
  workspaceId: WORKSPACE_ID,
  url: 'https://hooks.example.com/agent-workspace',
  events: ['run.completed', 'run.failed'],
  createdAt: '2026-10-31T00:00:00.000Z',
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly webhooks: WebhooksClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { webhooks: new WebhooksClient(http), calls: api.calls };
}

function problem(status: number, code: string): Response {
  return json(status, { error: { code, message: 'No.' } });
}

describe('WebhooksClient', () => {
  it('lists with GET /api/webhooks, sends no paging query and unwraps the envelope', async () => {
    const { webhooks, calls } = client(() => json(200, { webhooks: [webhook] }));
    expect(await webhooks.list()).toEqual([webhook]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.href).toBe('https://aw.example.com/api/webhooks');
  });

  it('creates with POST, the body as given, expects 201 and returns the secret once', async () => {
    const { webhooks, calls } = client(() => json(201, { webhook, secret: SECRET }));
    const input = { url: webhook.url, events: ['run.completed', 'run.failed'] } as const;
    expect(await webhooks.create(input)).toEqual({ webhook, secret: SECRET });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/webhooks');
    expect(calls[0]?.json).toEqual(input);
  });

  it('creates without events, leaving the default to the server', async () => {
    const { webhooks, calls } = client(() => json(201, { webhook, secret: SECRET }));
    await webhooks.create({ url: webhook.url });
    expect(calls[0]?.json).toEqual({ url: webhook.url });
  });

  it('removes with DELETE on an encoded id and resolves on the 204', async () => {
    const { webhooks, calls } = client(() => new Response(null, { status: 204 }));
    await expect(webhooks.remove('a/b')).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/webhooks/a%2Fb');
  });

  it.each([
    [403, 'forbidden'],
    [400, 'webhook_url_refused'],
    [409, 'webhook_limit_reached'],
  ])('maps a %i %s problem from create to ApiProblemError', async (status, code) => {
    const { webhooks } = client(() => problem(status, code));
    const failure = await webhooks.create({ url: webhook.url }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(status);
    expect((failure as ApiProblemError).code).toBe(code);
  });

  it('maps a 404 webhook_not_found from remove to ApiProblemError', async () => {
    const { webhooks } = client(() => problem(404, 'webhook_not_found'));
    const failure = await webhooks.remove(WEBHOOK_ID).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('webhook_not_found');
  });

  it('refuses a listed webhook carrying an unknown key such as a leaked secret', async () => {
    const { webhooks } = client(() => json(200, { webhooks: [{ ...webhook, secret: SECRET }] }));
    await expect(webhooks.list()).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('refuses a create answer whose secret is not a whsec_ secret', async () => {
    const { webhooks } = client(() => json(201, { webhook, secret: 'plain' }));
    await expect(webhooks.create({ url: webhook.url })).rejects.toBeInstanceOf(
      ContractViolationError,
    );
  });
});
