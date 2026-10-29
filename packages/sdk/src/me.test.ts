import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from './errors.js';
import { HttpClient } from './http.js';
import { readMe } from './me.js';
import { createClient } from './index.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from './testing.js';

const membershipPrincipal = {
  principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  kind: 'membership',
  role: 'admin',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  label: 'Aya Ito',
  features: ['chat', 'runs'],
};

const apiKeyPrincipal = {
  principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  kind: 'api-key',
  role: 'viewer',
  workspaceId: membershipPrincipal.workspaceId,
  userId: null,
  label: 'ci',
  features: ['chat', 'runs'],
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly http: HttpClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  return {
    http: new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: api.fetch,
    }),
    calls: api.calls,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('me', () => {
  it('reads the bare principal object of a session caller', async () => {
    const { http, calls } = client(() => json(200, membershipPrincipal));

    const me = await readMe(http);

    expect(me).toEqual(membershipPrincipal);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/me');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.headers.get('accept')).toBe('application/json');
    // A read with no body: nothing about the caller is sent beyond the credential.
    expect(call?.json).toBeUndefined();
  });

  it('reads an API-key principal, whose userId is null', async () => {
    const { http } = client(() => json(200, apiKeyPrincipal));

    const me = await readMe(http);

    expect(me.kind).toBe('api-key');
    expect(me.userId).toBeNull();
    expect(me.workspaceId).toBe(membershipPrincipal.workspaceId);
  });

  it('is reachable as a method on the root client, over the same transport', async () => {
    const api = fetchDouble(() => json(200, membershipPrincipal));
    const aw = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: api.fetch,
    });

    expect((await aw.me()).label).toBe('Aya Ito');
    expect(api.calls[0]?.url.pathname).toBe('/api/me');
    // `auth: { kind: 'session' }` sends no bearer and asks `fetch` for the browser's cookies.
    expect(api.calls[0]?.headers.get('authorization')).toBeNull();
    expect(api.calls[0]?.init.credentials).toBe('include');
  });

  it('surfaces a 401 by code — a revoked key and an expired session both land here', async () => {
    const { http } = client(() =>
      json(401, {
        error: { code: 'unauthenticated', detail: 'This route requires a credential.' },
      }),
    );

    const refused = await failure(readMe(http));

    expect(refused).toBeInstanceOf(ApiProblemError);
    expect((refused as ApiProblemError).status).toBe(401);
    expect((refused as ApiProblemError).code).toBe('unauthenticated');
  });

  it('refuses a body outside the contract rather than a partially trusted principal', async () => {
    // A field the server added. The contract is `.strict()`, so it is a violation and not a
    // silently dropped key: an unread field on this route could be a credential.
    const extra = client(() => json(200, { ...membershipPrincipal, apiKeyId: 'k-1' }));
    const leaked = await failure(readMe(extra.http));
    expect(leaked).toBeInstanceOf(ContractViolationError);
    expect((leaked as ContractViolationError).issues.join('\n')).toContain('apiKeyId');

    // The server's own stored spelling of the second kind, which the route must map before
    // sending. A client that accepted it would be publishing the database's vocabulary.
    const unmapped = client(() => json(200, { ...apiKeyPrincipal, kind: 'api_key' }));
    const drift = await failure(readMe(unmapped.http));
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).issues.join('\n')).toContain('kind');

    // A missing field.
    const withoutWorkspace = Object.fromEntries(
      Object.entries(membershipPrincipal).filter(([key]) => key !== 'workspaceId'),
    );
    const partial = client(() => json(200, withoutWorkspace));
    const missing = await failure(readMe(partial.http));
    expect(missing).toBeInstanceOf(ContractViolationError);
    expect((missing as ContractViolationError).status).toBe(200);
    expect((missing as ContractViolationError).issues.join('\n')).toContain('workspaceId');

    // A server one release behind, which does not send `features` yet (ADR-0160 D8).
    const beforeFeatures = Object.fromEntries(
      Object.entries(membershipPrincipal).filter(([key]) => key !== 'features'),
    );
    const older = client(() => json(200, beforeFeatures));
    const unsupported = await failure(readMe(older.http));
    expect(unsupported).toBeInstanceOf(ContractViolationError);
    expect((unsupported as ContractViolationError).issues.join('\n')).toContain('features');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { http, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });

    const aborted = await failure(readMe(http, { signal: controller.signal }));

    expect(aborted).toBeInstanceOf(TransportError);
    expect((aborted as TransportError).aborted).toBe(true);
    // The operation name the SDK reports for this call, which is how a caller tells one aborted
    // request from another.
    expect((aborted as TransportError).message).toContain('me:');
    expect(calls).toHaveLength(1);
  });
});
