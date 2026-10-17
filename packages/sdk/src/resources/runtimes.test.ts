import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { RuntimeConnectionsClient, RuntimeProfilesClient, RuntimesClient } from './runtimes.js';

const PROFILE = '88888888-8888-4888-8888-888888888888';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const profile = {
  id: PROFILE,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'Standard',
  driver: 'docker',
  runtimeConnectionId: null,
  cpu: 1,
  memoryMb: 1024,
  diskMb: null,
  networkPolicy: 'restricted',
  allowedDomains: ['api.anthropic.com'],
  filesystem: 'read-write',
  persistPaths: null,
  timeoutSeconds: null,
  idleTimeoutSeconds: null,
  driverConfig: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const connection = {
  id: CONNECTION,
  name: 'RUNTIME_CONNECTION__DOCKER__PRIMARY',
  driver: 'docker',
  createdAt: '2026-09-21T10:00:00.000Z',
};

const problem = (status: number, code: string) => json(status, { error: { code, message: code } });

function client(route: (request: RecordedRequest) => Response): {
  readonly runtimes: RuntimesClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { runtimes: new RuntimesClient(http), calls: api.calls };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectProblem(error: unknown, status: number, code: string): void {
  expect(error).toBeInstanceOf(ApiProblemError);
  expect((error as ApiProblemError).status).toBe(status);
  expect((error as ApiProblemError).code).toBe(code);
}

describe('RuntimesClient', () => {
  it('exposes one client per sub-resource', () => {
    const { runtimes } = client(() => json(200, {}));
    expect(runtimes.profiles).toBeInstanceOf(RuntimeProfilesClient);
    expect(runtimes.connections).toBeInstanceOf(RuntimeConnectionsClient);
  });
});

describe('RuntimesClient.profiles.list', () => {
  it('reads the list envelope and returns the bare items', async () => {
    const { runtimes, calls } = client(() => json(200, { runtimeProfiles: [profile] }));
    const profiles = await runtimes.profiles.list();
    expect(profiles).toEqual([profile]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/runtime-profiles');
    expect(calls[0]?.url.search).toBe('');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
  });

  it('surfaces a deployment that has no runtime store as its own 503', async () => {
    const { runtimes } = client(() => problem(503, 'runtimes_runtime_not_configured'));
    expectProblem(await failure(runtimes.profiles.list()), 503, 'runtimes_runtime_not_configured');
  });

  it('refuses an item that carries an unknown field as a contract violation', async () => {
    const { runtimes } = client(() => json(200, { runtimeProfiles: [{ ...profile, image: 'x' }] }));
    expect(await failure(runtimes.profiles.list())).toBeInstanceOf(ContractViolationError);
  });
});

describe('RuntimesClient.profiles.get', () => {
  it('percent-encodes the id and reads the bare item', async () => {
    const { runtimes, calls } = client(() => json(200, profile));
    expect(await runtimes.profiles.get('a/b c')).toEqual(profile);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/runtime-profiles/a%2Fb%20c');
  });

  it('surfaces a non-UUID id and an unknown id by code', async () => {
    const invalid = client(() => problem(400, 'invalid_runtime_profile_id'));
    expectProblem(
      await failure(invalid.runtimes.profiles.get('latest')),
      400,
      'invalid_runtime_profile_id',
    );
    const missing = client(() => problem(404, 'runtime_profile_not_found'));
    expectProblem(
      await failure(missing.runtimes.profiles.get(PROFILE)),
      404,
      'runtime_profile_not_found',
    );
  });

  it('refuses a wrapped item as a contract violation', async () => {
    const { runtimes } = client(() => json(200, { runtimeProfile: profile }));
    const error = await failure(runtimes.profiles.get(PROFILE));
    expect(error).toBeInstanceOf(ContractViolationError);
    expect((error as ContractViolationError).status).toBe(200);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtimes } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await failure(runtimes.profiles.get(PROFILE, { signal: controller.signal }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});

describe('RuntimesClient.profiles.create', () => {
  const input = {
    name: 'Standard',
    driver: 'docker',
    networkPolicy: 'restricted',
    allowedDomains: ['api.anthropic.com'],
    filesystem: 'read-write',
    cpu: 1,
    memoryMb: 1024,
  } as const;

  it('posts the body as the route parses it and reads the 201', async () => {
    const { runtimes, calls } = client(() => json(201, profile));
    expect(await runtimes.profiles.create(input)).toEqual(profile);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/runtime-profiles');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.json).toEqual(input);
  });

  it('surfaces every refusal the route documents by status and code', async () => {
    const cases: readonly (readonly [number, string])[] = [
      [400, 'invalid_body'],
      [400, 'malformed_body'],
      [400, 'unknown_runtime_connection'],
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [409, 'runtime_profile_name_conflict'],
      [413, 'request_body_too_large'],
      [415, 'unsupported_media_type'],
      [422, 'network_policy_not_enforceable'],
      [503, 'runtimes_runtime_not_configured'],
    ];
    for (const [status, code] of cases) {
      const { runtimes } = client(() => problem(status, code));
      expectProblem(await failure(runtimes.profiles.create(input)), status, code);
    }
  });

  it('keeps the per-field details of an invalid body', async () => {
    const { runtimes } = client(() =>
      json(400, {
        error: { code: 'invalid_body', message: 'no', details: ['memoryMb: must be positive'] },
      }),
    );
    const error = await failure(runtimes.profiles.create({ ...input, memoryMb: 0 }));
    expect((error as ApiProblemError).details).toEqual(['memoryMb: must be positive']);
  });

  it('refuses a 201 whose driver is outside the catalogue', async () => {
    const { runtimes } = client(() => json(201, { ...profile, driver: 'podman' }));
    expect(await failure(runtimes.profiles.create(input))).toBeInstanceOf(ContractViolationError);
  });
});

describe('RuntimesClient.profiles.update', () => {
  it('patches only the given fields and reads the 200', async () => {
    const { runtimes, calls } = client(() => json(200, { ...profile, networkPolicy: 'none' }));
    const updated = await runtimes.profiles.update(PROFILE, { networkPolicy: 'none' });
    expect(updated.networkPolicy).toBe('none');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/api/runtime-profiles/${PROFILE}`);
    expect(calls[0]?.json).toEqual({ networkPolicy: 'none' });
  });

  it('surfaces every refusal the route documents by status and code', async () => {
    const cases: readonly (readonly [number, string])[] = [
      [400, 'invalid_runtime_profile_id'],
      [400, 'invalid_body'],
      [400, 'unknown_runtime_connection'],
      [404, 'runtime_profile_not_found'],
      [409, 'runtime_profile_name_conflict'],
      [422, 'network_policy_not_enforceable'],
    ];
    for (const [status, code] of cases) {
      const { runtimes } = client(() => problem(status, code));
      expectProblem(await failure(runtimes.profiles.update(PROFILE, { name: 'x' })), status, code);
    }
  });

  it('refuses a body that is not JSON as a contract violation', async () => {
    const { runtimes } = client(
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(await failure(runtimes.profiles.update(PROFILE, { name: 'x' }))).toBeInstanceOf(
      ContractViolationError,
    );
  });
});

describe('RuntimesClient.profiles.remove', () => {
  it('sends DELETE and resolves on 204', async () => {
    const { runtimes, calls } = client(() => json(204, null));
    await expect(runtimes.profiles.remove(PROFILE)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe(`/api/runtime-profiles/${PROFILE}`);
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('surfaces an unknown profile and a malformed id by code', async () => {
    const missing = client(() => problem(404, 'runtime_profile_not_found'));
    expectProblem(
      await failure(missing.runtimes.profiles.remove(PROFILE)),
      404,
      'runtime_profile_not_found',
    );
    const invalid = client(() => problem(400, 'invalid_runtime_profile_id'));
    expectProblem(
      await failure(invalid.runtimes.profiles.remove('nope')),
      400,
      'invalid_runtime_profile_id',
    );
  });

  it('refuses a 200 with a body where a 204 was promised', async () => {
    const { runtimes } = client(() => json(200, profile));
    expectProblem(await failure(runtimes.profiles.remove(PROFILE)), 200, 'unrecognised_error_body');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtimes } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await failure(runtimes.profiles.remove(PROFILE, { signal: controller.signal }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});

describe('RuntimesClient.connections.list', () => {
  it('reads the list envelope and returns the bare items', async () => {
    const { runtimes, calls } = client(() => json(200, { runtimeConnections: [connection] }));
    expect(await runtimes.connections.list()).toEqual([connection]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/runtime-connections');
  });

  it('surfaces the unconfigured deployment by code', async () => {
    const { runtimes } = client(() => problem(503, 'runtimes_runtime_not_configured'));
    expectProblem(
      await failure(runtimes.connections.list()),
      503,
      'runtimes_runtime_not_configured',
    );
  });

  it('refuses an item that leaks an endpoint or credential as a contract violation', async () => {
    const { runtimes } = client(() =>
      json(200, { runtimeConnections: [{ ...connection, credential: 'sealed?' }] }),
    );
    expect(await failure(runtimes.connections.list())).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtimes } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await failure(runtimes.connections.list({ signal: controller.signal }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});

describe('RuntimesClient.connections.create', () => {
  const input = {
    name: 'Primary',
    driver: 'docker',
    endpoint: 'tcp://docker.internal:2376',
    credential: 'cert-and-key',
  } as const;

  it('posts the four fields and reads the 201 without the credential', async () => {
    const { runtimes, calls } = client(() => json(201, connection));
    expect(await runtimes.connections.create(input)).toEqual(connection);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/runtime-connections');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.json).toEqual(input);
  });

  it('surfaces every refusal the route documents by status and code', async () => {
    const cases: readonly (readonly [number, string])[] = [
      [400, 'invalid_body'],
      [400, 'malformed_body'],
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [409, 'runtime_connection_name_conflict'],
      [413, 'request_body_too_large'],
      [415, 'unsupported_media_type'],
      [503, 'runtimes_runtime_not_configured'],
    ];
    for (const [status, code] of cases) {
      const { runtimes } = client(() => problem(status, code));
      expectProblem(await failure(runtimes.connections.create(input)), status, code);
    }
  });

  it('refuses a 201 that echoes the endpoint back', async () => {
    const { runtimes } = client(() => json(201, { ...connection, endpoint: input.endpoint }));
    expect(await failure(runtimes.connections.create(input))).toBeInstanceOf(
      ContractViolationError,
    );
  });
});
