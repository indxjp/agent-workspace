import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { SecretsClient } from './secrets.js';

const SECRET = '88888888-8888-4888-8888-888888888888';
const VALUE = 'sk-ant-api03-plaintext-that-must-never-come-back';

const secret = {
  id: SECRET,
  name: 'ANTHROPIC_API_KEY',
  algorithm: 'aes-256-gcm',
  masterKeyId: 'local-dev-key-1',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly secrets: SecretsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { secrets: new SecretsClient(http), calls: api.calls };
}

describe('SecretsClient.list', () => {
  it('reads the list envelope and unwraps it', async () => {
    const { secrets, calls } = client(() => json(200, { secrets: [secret] }));
    const listed = await secrets.list();
    expect(listed).toEqual([secret]);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/secrets');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.json).toBeUndefined();
  });

  it('refuses a list whose item carries a value, as a contract violation', async () => {
    const { secrets } = client(() => json(200, { secrets: [{ ...secret, value: VALUE }] }));
    const failure = await secrets.list().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain('value');
  });

  it('surfaces the unwired-runtime and unauthenticated problems by code', async () => {
    const unwired = client(() =>
      json(503, { error: { code: 'secrets_runtime_not_configured', message: 'No store.' } }),
    );
    const unavailable = await unwired.secrets.list().catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(ApiProblemError);
    expect((unavailable as ApiProblemError).status).toBe(503);
    expect((unavailable as ApiProblemError).code).toBe('secrets_runtime_not_configured');

    const anonymous = client(() =>
      json(401, { error: { code: 'unauthenticated', message: 'Sign in.' } }),
    );
    const refused = await anonymous.secrets.list().catch((e: unknown) => e);
    expect((refused as ApiProblemError).code).toBe('unauthenticated');
  });
});

describe('SecretsClient.list and replace by name', () => {
  it('filters the list by name', async () => {
    const { secrets, calls } = client(() => json(200, { secrets: [secret] }));
    await secrets.list({ name: 'ANTHROPIC_API_KEY' });
    expect(calls[0]?.url.search).toBe('?name=ANTHROPIC_API_KEY');
  });

  it('selects the exact name when an older server ignores the filter, and refuses no match', async () => {
    const other = { ...secret, id: '99999999-9999-4999-8999-999999999999', name: 'OTHER_KEY' };
    const { secrets, calls } = client((request) =>
      request.method === 'GET' ? json(200, { secrets: [other, secret] }) : json(200, secret),
    );
    await secrets.replace({ name: 'ANTHROPIC_API_KEY' }, VALUE);
    expect(calls[1]?.url.pathname).toBe(`/api/secrets/${SECRET}`);

    const none = client(() => json(200, { secrets: [other] }));
    const failure = await none.secrets
      .replace({ name: 'ANTHROPIC_API_KEY' }, VALUE)
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('secret_not_found');
    expect(none.calls).toHaveLength(1);
  });

  it('replaces by { name } through the filtered list, and passes the 404 on', async () => {
    const { secrets, calls } = client((request) =>
      request.method === 'GET' ? json(200, { secrets: [secret] }) : json(200, secret),
    );
    await secrets.replace({ name: 'ANTHROPIC_API_KEY' }, VALUE);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      'GET /api/secrets?name=ANTHROPIC_API_KEY',
      `PUT /api/secrets/${SECRET}`,
    ]);

    const missing = client(() =>
      json(404, { error: { code: 'secret_not_found', message: 'No such secret.' } }),
    );
    const failure = await missing.secrets.replace({ name: 'NOPE' }, VALUE).catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('secret_not_found');
    expect(missing.calls).toHaveLength(1);
  });
});

describe('SecretsClient.create', () => {
  it('posts exactly { name, value } and reads the bare 201', async () => {
    const { secrets, calls } = client(() => json(201, secret));
    const created = await secrets.create({ name: 'ANTHROPIC_API_KEY', value: VALUE });
    expect(created).toEqual(secret);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/secrets');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({ name: 'ANTHROPIC_API_KEY', value: VALUE });
  });

  it('sends only the two fields the route accepts, even when the caller passes more', async () => {
    const { secrets, calls } = client(() => json(201, secret));
    const input = { name: 'ANTHROPIC_API_KEY', value: VALUE, description: 'not a field' };
    await secrets.create(input);
    expect(calls[0]?.json).toEqual({ name: 'ANTHROPIC_API_KEY', value: VALUE });
  });

  it('surfaces the route refusals: invalid body with details, and a name conflict', async () => {
    const invalid = client(() =>
      json(400, {
        error: {
          code: 'invalid_body',
          message: 'The secret could not be created from this body.',
          details: ['name must be uppercase letters, digits and underscores…'],
        },
      }),
    );
    const malformed = await invalid.secrets
      .create({ name: 'lowercase', value: VALUE })
      .catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(ApiProblemError);
    expect((malformed as ApiProblemError).status).toBe(400);
    expect((malformed as ApiProblemError).code).toBe('invalid_body');
    expect((malformed as ApiProblemError).details).toHaveLength(1);

    const taken = client(() =>
      json(409, { error: { code: 'secret_name_conflict', message: 'Already there.' } }),
    );
    const conflict = await taken.secrets
      .create({ name: 'ANTHROPIC_API_KEY', value: VALUE })
      .catch((e: unknown) => e);
    expect((conflict as ApiProblemError).status).toBe(409);
    expect((conflict as ApiProblemError).code).toBe('secret_name_conflict');
  });

  it('refuses a 201 that echoes the value back, and one missing a field', async () => {
    const echoed = client(() => json(201, { ...secret, value: VALUE }));
    const leak = await echoed.secrets
      .create({ name: 'ANTHROPIC_API_KEY', value: VALUE })
      .catch((e: unknown) => e);
    expect(leak).toBeInstanceOf(ContractViolationError);
    expect((leak as ContractViolationError).status).toBe(201);

    const withoutMasterKey = Object.fromEntries(
      Object.entries(secret).filter(([key]) => key !== 'masterKeyId'),
    );
    const partial = client(() => json(201, withoutMasterKey));
    const drift = await partial.secrets
      .create({ name: 'ANTHROPIC_API_KEY', value: VALUE })
      .catch((e: unknown) => e);
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).issues.join('\n')).toContain('masterKeyId');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { secrets, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await secrets
      .create({ name: 'ANTHROPIC_API_KEY', value: VALUE }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('SecretsClient.replace', () => {
  it('puts exactly { value } to the percent-encoded id and reads the bare 200', async () => {
    const rotated = { ...secret, updatedAt: '2026-09-21T11:00:00.000Z' };
    const { secrets, calls } = client(() => json(200, rotated));
    const replaced = await secrets.replace(SECRET, VALUE);
    expect(replaced).toEqual(rotated);
    const [call] = calls;
    expect(call?.method).toBe('PUT');
    expect(call?.url.pathname).toBe(`/api/secrets/${SECRET}`);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({ value: VALUE });
  });

  it('encodes a caller-supplied id so it cannot escape the path', async () => {
    const { secrets, calls } = client(() =>
      json(400, { error: { code: 'invalid_secret_id', message: 'Not a UUID.' } }),
    );
    const failure = await secrets.replace('../agents?x=1#f', VALUE).catch((e: unknown) => e);
    expect(calls[0]?.url.pathname).toBe('/api/secrets/..%2Fagents%3Fx%3D1%23f');
    expect(calls[0]?.url.search).toBe('');
    expect((failure as ApiProblemError).status).toBe(400);
    expect((failure as ApiProblemError).code).toBe('invalid_secret_id');
  });

  it('surfaces a missing secret and a refused body by code', async () => {
    const missing = client(() =>
      json(404, { error: { code: 'secret_not_found', message: 'No such secret.' } }),
    );
    const notFound = await missing.secrets.replace(SECRET, VALUE).catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(ApiProblemError);
    expect((notFound as ApiProblemError).status).toBe(404);
    expect((notFound as ApiProblemError).code).toBe('secret_not_found');

    const empty = client(() =>
      json(400, {
        error: {
          code: 'invalid_body',
          message: 'The secret could not be replaced from this body.',
          details: ['value must not be empty.'],
        },
      }),
    );
    const refused = await empty.secrets.replace(SECRET, '').catch((e: unknown) => e);
    expect((refused as ApiProblemError).code).toBe('invalid_body');
  });

  it('refuses a 200 that echoes the value back', async () => {
    const { secrets } = client(() => json(200, { ...secret, value: VALUE }));
    const failure = await secrets.replace(SECRET, VALUE).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { secrets } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await secrets
      .replace(SECRET, VALUE, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('SecretsClient.remove', () => {
  it('deletes by id and resolves on the 204', async () => {
    const { secrets, calls } = client(() => new Response(null, { status: 204 }));
    await expect(secrets.remove(SECRET)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe(`/api/secrets/${SECRET}`);
    expect(calls[0]?.json).toBeUndefined();
  });

  it('surfaces secret_in_use with the referrers in details', async () => {
    const connectorId = '55555555-5555-4555-8555-555555555555';
    const { secrets } = client(() =>
      json(409, {
        error: {
          code: 'secret_in_use',
          message: 'Still referenced.',
          details: [`connector:${connectorId}`],
        },
      }),
    );
    const failure = await secrets.remove(SECRET).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(409);
    expect((failure as ApiProblemError).code).toBe('secret_in_use');
    expect((failure as ApiProblemError).details).toEqual([`connector:${connectorId}`]);
  });
});
