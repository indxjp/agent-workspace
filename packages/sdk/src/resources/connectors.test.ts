import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, fixtures, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { ConnectorsClient, type ToolConnectorBody } from './connectors.js';

const CONNECTOR = '77777777-7777-4777-8777-777777777777';
const CREDENTIAL = 'ghp_plaintext-that-must-never-come-back';

const connector = {
  id: CONNECTOR,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'GitHub',
  transport: 'http',
  command: null,
  args: null,
  url: 'https://mcp.example.com/mcp',
  authType: 'bearer',
  hasCredential: true,
  enabled: true,
  createdBy: null,
  ownerPrincipalId: 'principal-1',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const connected = {
  ok: true,
  kind: 'ok',
  message: 'Connected. The server answered and accepted the credential.',
  serverName: 'github-mcp',
  serverVersion: '1.2.0',
  toolCount: 12,
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly connectors: ConnectorsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { connectors: new ConnectorsClient(http), calls: api.calls };
}

describe('ConnectorsClient.list', () => {
  it('reads the list envelope and unwraps it', async () => {
    const { connectors, calls } = client(() => json(200, { connectors: [connector] }));
    expect(await connectors.list()).toEqual([connector]);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/connectors');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.json).toBeUndefined();
  });

  it('refuses an item that carries a credential, as a contract violation', async () => {
    const { connectors } = client(() =>
      json(200, { connectors: [{ ...connector, credential: CREDENTIAL }] }),
    );
    const failure = await connectors.list().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain('credential');
  });

  it('surfaces the unwired-runtime, unauthenticated and forbidden problems by code', async () => {
    const unwired = client(() =>
      json(503, { error: { code: 'connectors_runtime_not_configured', message: 'No store.' } }),
    );
    const unavailable = await unwired.connectors.list().catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(ApiProblemError);
    expect((unavailable as ApiProblemError).status).toBe(503);
    expect((unavailable as ApiProblemError).code).toBe('connectors_runtime_not_configured');

    const anonymous = client(() =>
      json(401, { error: { code: 'unauthenticated', message: 'Sign in.' } }),
    );
    const refused = await anonymous.connectors.list().catch((e: unknown) => e);
    expect((refused as ApiProblemError).code).toBe('unauthenticated');

    const viewer = client(() => json(403, { error: { code: 'forbidden', message: 'No.' } }));
    const denied = await viewer.connectors.list().catch((e: unknown) => e);
    expect((denied as ApiProblemError).status).toBe(403);
    expect((denied as ApiProblemError).code).toBe('forbidden');
  });
});

describe('ConnectorsClient.get', () => {
  it('reads the bare resource from the percent-encoded path', async () => {
    const { connectors, calls } = client(() => json(200, connector));
    expect(await connectors.get(CONNECTOR)).toEqual(connector);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe(`/api/connectors/${CONNECTOR}`);
  });

  it('encodes a caller-supplied id so it cannot escape the path', async () => {
    const { connectors, calls } = client(() =>
      json(404, { error: { code: 'connector_not_found', message: 'No such connector.' } }),
    );
    const failure = await connectors.get('../agents?x=1#f').catch((e: unknown) => e);
    expect(calls[0]?.url.pathname).toBe('/api/connectors/..%2Fagents%3Fx%3D1%23f');
    expect(calls[0]?.url.search).toBe('');
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('connector_not_found');
  });

  it('surfaces a missing connector by code', async () => {
    const { connectors } = client(() =>
      json(404, { error: { code: 'connector_not_found', message: 'No such connector.' } }),
    );
    const failure = await connectors.get(CONNECTOR).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('connector_not_found');
  });

  it('refuses a 200 missing a field', async () => {
    const withoutOwner = Object.fromEntries(
      Object.entries(connector).filter(([key]) => key !== 'ownerPrincipalId'),
    );
    const { connectors } = client(() => json(200, withoutOwner));
    const failure = await connectors.get(CONNECTOR).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain('ownerPrincipalId');
  });
});

describe('ConnectorsClient.create', () => {
  it('posts a remote connector body as the route parses it and reads the bare 201', async () => {
    const { connectors, calls } = client(() => json(201, connector));
    const created = await connectors.create({
      name: 'GitHub',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      authType: 'bearer',
      credential: CREDENTIAL,
    });
    expect(created).toEqual(connector);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/connectors');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({
      name: 'GitHub',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      authType: 'bearer',
      credential: CREDENTIAL,
    });
  });

  it('posts a stdio connector with only the fields given, and never a dryRun flag', async () => {
    const { connectors, calls } = client(() =>
      json(201, {
        ...connector,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        url: null,
        authType: 'none',
        hasCredential: false,
      }),
    );
    await connectors.create({
      name: 'FS',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
    });
    expect(calls[0]?.json).toEqual({
      name: 'FS',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
    });

    await connectors.create({ name: 'FS', transport: 'stdio', command: 'npx' });
    expect(calls[1]?.json).toEqual({ name: 'FS', transport: 'stdio', command: 'npx' });
    expect(Object.keys(calls[1]?.json as object)).not.toContain('dryRun');
  });

  it('sends only the fields the route accepts, even when the caller passes more', async () => {
    const { connectors, calls } = client(() => json(201, connector));
    const input = {
      name: 'GitHub',
      transport: 'http' as const,
      url: 'https://mcp.example.com/mcp',
      enabled: false,
    };
    await connectors.create(input);
    expect(calls[0]?.json).toEqual({
      name: 'GitHub',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('surfaces the route refusals: invalid body with details, and a name conflict', async () => {
    const invalid = client(() =>
      json(400, {
        error: {
          code: 'invalid_body',
          message: 'The connector could not be created from this body.',
          details: ['"url" is required and must be an absolute http(s) URL for a remote connector'],
        },
      }),
    );
    const malformed = await invalid.connectors
      .create({ name: 'GitHub', transport: 'http', url: 'mcp.example.com' })
      .catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(ApiProblemError);
    expect((malformed as ApiProblemError).status).toBe(400);
    expect((malformed as ApiProblemError).code).toBe('invalid_body');
    expect((malformed as ApiProblemError).details).toHaveLength(1);

    const taken = client(() =>
      json(409, { error: { code: 'connector_name_conflict', message: 'Already there.' } }),
    );
    const conflict = await taken.connectors
      .create({ name: 'GitHub', transport: 'http', url: 'https://mcp.example.com/mcp' })
      .catch((e: unknown) => e);
    expect((conflict as ApiProblemError).status).toBe(409);
    expect((conflict as ApiProblemError).code).toBe('connector_name_conflict');
  });

  it('refuses a 201 that echoes the credential back', async () => {
    const { connectors } = client(() => json(201, { ...connector, credential: CREDENTIAL }));
    const failure = await connectors
      .create({
        name: 'GitHub',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        authType: 'bearer',
        credential: CREDENTIAL,
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).status).toBe(201);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { connectors, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await connectors
      .create(
        { name: 'GitHub', transport: 'http', url: 'https://mcp.example.com/mcp' },
        { signal: controller.signal },
      )
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('ConnectorsClient.remove', () => {
  it('deletes by the percent-encoded id and resolves on the 204', async () => {
    const { connectors, calls } = client(() => json(204, null));
    await expect(connectors.remove(CONNECTOR)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe(`/api/connectors/${CONNECTOR}`);
    expect(calls[0]?.json).toBeUndefined();
  });

  it('surfaces a missing connector by code', async () => {
    const { connectors } = client(() =>
      json(404, { error: { code: 'connector_not_found', message: 'No such connector.' } }),
    );
    const failure = await connectors.remove(CONNECTOR).catch((e: unknown) => e);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('connector_not_found');
  });

  it('refuses a 200 with a body where a 204 was promised', async () => {
    const { connectors } = client(() => json(200, connector));
    const failure = await connectors.remove(CONNECTOR).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('unrecognised_error_body');
  });
});

describe('ConnectorsClient.rotateCredential', () => {
  it('patches exactly { credential } and reads the bare 200', async () => {
    const rotated = { ...connector, updatedAt: '2026-09-21T11:00:00.000Z' };
    const { connectors, calls } = client(() => json(200, rotated));
    expect(await connectors.rotateCredential(CONNECTOR, CREDENTIAL)).toEqual(rotated);
    const [call] = calls;
    expect(call?.method).toBe('PATCH');
    expect(call?.url.pathname).toBe(`/api/connectors/${CONNECTOR}`);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({ credential: CREDENTIAL });
  });

  it('surfaces a blank credential, an unauthenticated connector and a missing one by code', async () => {
    const blank = client(() =>
      json(400, { error: { code: 'invalid_credential', message: 'Blank.' } }),
    );
    const refused = await blank.connectors
      .rotateCredential(CONNECTOR, ' ')
      .catch((e: unknown) => e);
    expect((refused as ApiProblemError).status).toBe(400);
    expect((refused as ApiProblemError).code).toBe('invalid_credential');

    const noSlot = client(() =>
      json(409, { error: { code: 'credential_not_configured', message: 'No slot.' } }),
    );
    const conflict = await noSlot.connectors
      .rotateCredential(CONNECTOR, CREDENTIAL)
      .catch((e: unknown) => e);
    expect((conflict as ApiProblemError).status).toBe(409);
    expect((conflict as ApiProblemError).code).toBe('credential_not_configured');

    const missing = client(() =>
      json(404, { error: { code: 'connector_not_found', message: 'No such connector.' } }),
    );
    const notFound = await missing.connectors
      .rotateCredential(CONNECTOR, CREDENTIAL)
      .catch((e: unknown) => e);
    expect((notFound as ApiProblemError).code).toBe('connector_not_found');
  });

  it('refuses a 200 that echoes the credential back', async () => {
    const { connectors } = client(() => json(200, { ...connector, credential: CREDENTIAL }));
    const failure = await connectors
      .rotateCredential(CONNECTOR, CREDENTIAL)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { connectors } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await connectors
      .rotateCredential(CONNECTOR, CREDENTIAL, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('ConnectorsClient.test', () => {
  it('posts to the test-connection sub-resource with no body and reads a success', async () => {
    const { connectors, calls } = client(() => json(200, connected));
    expect(await connectors.test(CONNECTOR)).toEqual(connected);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe(`/api/connectors/${CONNECTOR}/test-connection`);
    expect(call?.json).toBeUndefined();
    expect(call?.headers.has('content-type')).toBe(false);
  });

  it('reads a failed probe as a value, not an error — a 200 with ok: false', async () => {
    const refusal = {
      ok: false,
      kind: 'stdio-probe-unavailable',
      message: 'Test Connection cannot run a stdio server in this deployment.',
    };
    const { connectors } = client(() => json(200, refusal));
    const outcome = await connectors.test(CONNECTOR);
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('stdio-probe-unavailable');
  });

  it('surfaces a missing connector by code, and refuses an unknown failure kind', async () => {
    const missing = client(() =>
      json(404, { error: { code: 'connector_not_found', message: 'No such connector.' } }),
    );
    const notFound = await missing.connectors.test(CONNECTOR).catch((e: unknown) => e);
    expect((notFound as ApiProblemError).status).toBe(404);
    expect((notFound as ApiProblemError).code).toBe('connector_not_found');

    const drifted = client(() => json(200, { ok: false, kind: 'quota-exceeded', message: 'x' }));
    const failure = await drifted.connectors.test(CONNECTOR).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { connectors } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await connectors
      .test(CONNECTOR, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('ConnectorsClient.testDraft', () => {
  it('posts the create body with dryRun: true to the collection and reads the outcome', async () => {
    const { connectors, calls } = client(() => json(200, connected));
    const outcome = await connectors.testDraft({
      name: 'GitHub',
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      authType: 'api-key',
      credential: CREDENTIAL,
    });
    expect(outcome).toEqual(connected);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/connectors');
    expect(call?.json).toEqual({
      name: 'GitHub',
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      authType: 'api-key',
      credential: CREDENTIAL,
      dryRun: true,
    });
  });

  it('surfaces an invalid draft by code and refuses a 201 where the probe was promised', async () => {
    const invalid = client(() =>
      json(400, {
        error: {
          code: 'invalid_body',
          message: 'The connector could not be created from this body.',
          details: ['"credential" is required when "authType" is "bearer"'],
        },
      }),
    );
    const refused = await invalid.connectors
      .testDraft({ name: 'GitHub', transport: 'http', url: 'https://x', authType: 'bearer' })
      .catch((e: unknown) => e);
    expect((refused as ApiProblemError).status).toBe(400);
    expect((refused as ApiProblemError).code).toBe('invalid_body');

    const persisted = client(() => json(201, connector));
    const failure = await persisted.connectors
      .testDraft({ name: 'GitHub', transport: 'http', url: 'https://x' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(201);
  });

  it('refuses an outcome that mixes the two arms, as a contract violation', async () => {
    const { connectors } = client(() => json(200, { ...connected, ok: false }));
    const failure = await connectors
      .testDraft({ name: 'GitHub', transport: 'http', url: 'https://x' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { connectors } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await connectors
      .testDraft(
        { name: 'GitHub', transport: 'http', url: 'https://x' },
        { signal: controller.signal },
      )
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('ConnectorsClient.update', () => {
  it('patches only the fields given and reads the bare 200', async () => {
    const updated = { ...connector, name: 'GitHub (renamed)', enabled: false };
    const { connectors, calls } = client(() => json(200, updated));
    expect(
      await connectors.update(CONNECTOR, { name: 'GitHub (renamed)', enabled: false }),
    ).toEqual(updated);
    const [call] = calls;
    expect(call?.method).toBe('PATCH');
    expect(call?.url.pathname).toBe(`/api/connectors/${CONNECTOR}`);
    expect(call?.json).toEqual({ name: 'GitHub (renamed)', enabled: false });
  });

  it('sends a credential with authType and refuses an answer that carries one back', async () => {
    const { connectors, calls } = client(() => json(200, { ...connector, credential: CREDENTIAL }));
    const failure = await connectors
      .update(CONNECTOR, { authType: 'api-key', credential: CREDENTIAL })
      .catch((e: unknown) => e);
    expect(calls[0]?.json).toEqual({ authType: 'api-key', credential: CREDENTIAL });
    expect(failure).toBeInstanceOf(ContractViolationError);
  });
});

describe('ConnectorsClient tool kinds (C15, issue #533)', () => {
  const openApi = fixtures.openApiConnector();
  const postgres = fixtures.postgresConnector();
  const DOCUMENT = '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}';
  const DATABASE_URL = 'postgres://reader:secret@db.example.com/orders';

  /** A tool body as an untyped caller can pass it, carrying keys the type does not name. */
  const untyped = (body: Record<string, unknown>): ToolConnectorBody => body as ToolConnectorBody;

  it('posts exactly the openapi body, with and without a base URL, and reads the 201', async () => {
    const { connectors, calls } = client(() => json(201, openApi));
    const body = {
      kind: 'openapi',
      name: 'orders-api',
      document: DOCUMENT,
      allow: ['GET /**'],
      auth: 'bearer',
      credential: CREDENTIAL,
    } as const;
    expect(await connectors.create(body)).toEqual(openApi);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/connectors');
    expect(calls[0]?.json).toStrictEqual(body);

    await connectors.create({ ...body, baseUrl: 'https://api.example.com' });
    expect(calls[1]?.json).toStrictEqual({ ...body, baseUrl: 'https://api.example.com' });
  });

  it('posts the postgres body, with maxRows only when it is given', async () => {
    const { connectors, calls } = client(() => json(201, postgres));
    const body = {
      kind: 'postgres',
      name: 'orders-db',
      credential: DATABASE_URL,
      tables: ['public.orders'],
      readOnly: true,
    } as const;
    expect(await connectors.create(body)).toEqual(postgres);
    expect(calls[0]?.json).toStrictEqual(body);

    await connectors.create({ ...body, maxRows: 50 });
    expect(calls[1]?.json).toStrictEqual({ ...body, maxRows: 50 });
  });

  it('never sends dryRun or a key the body type does not name', async () => {
    const { connectors, calls } = client(() => json(201, postgres));
    await connectors.create(
      untyped({
        kind: 'postgres',
        name: 'orders-db',
        credential: DATABASE_URL,
        tables: ['public.orders'],
        readOnly: true,
        dryRun: true,
        ownerPrincipalId: 'someone-else',
      }),
    );
    expect(calls[0]?.json).toStrictEqual({
      kind: 'postgres',
      name: 'orders-db',
      credential: DATABASE_URL,
      tables: ['public.orders'],
      readOnly: true,
    });
  });

  it('patches the whole body to update a tool connector and reads the 200', async () => {
    const { connectors, calls } = client(() => json(200, openApi));
    const body = {
      kind: 'openapi',
      name: 'orders-api',
      document: DOCUMENT,
      allow: ['GET /orders'],
      auth: { header: 'X-Api-Key' },
      credential: CREDENTIAL,
    } as const;
    expect(await connectors.update(openApi.id, body)).toEqual(openApi);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/api/connectors/${openApi.id}`);
    expect(calls[0]?.json).toStrictEqual(body);
  });

  it.each([
    ['missing its openapi half', { ...openApi, openapi: undefined }, 'openapi'],
    ['carrying the credential', { ...openApi, credential: CREDENTIAL }, 'credential'],
  ])('refuses a 201 openapi resource %s', async (_case, resource, key) => {
    const { connectors } = client(() => json(201, resource));
    const failure = await connectors
      .create({ kind: 'openapi', name: 'orders-api', document: DOCUMENT, allow: ['GET /**'] })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain(key);
  });

  it('keeps the MCP create and update bodies as they were', async () => {
    const { connectors, calls } = client((request) =>
      json(request.method === 'POST' ? 201 : 200, connector),
    );
    await connectors.create({ name: 'Local', transport: 'stdio', command: 'npx', args: ['mcp'] });
    await connectors.update(CONNECTOR, {
      url: 'https://mcp.example.com/v2',
      credential: CREDENTIAL,
    });
    await connectors.update(CONNECTOR, { args: null });
    expect(calls.map((call) => call.json)).toStrictEqual([
      { name: 'Local', transport: 'stdio', command: 'npx', args: ['mcp'] },
      { url: 'https://mcp.example.com/v2', credential: CREDENTIAL },
      { args: null },
    ]);
  });
});

describe('ConnectorsClient identity opt-in (ADR-0142 D1)', () => {
  const identity = { secret: 'CRM_IDENTITY_SECRET' };
  const DOCUMENT = '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}';

  it('forwards identity in the MCP create, dry-run and patch bodies, and null to remove it', async () => {
    const { connectors, calls } = client((request) =>
      request.json !== null && typeof request.json === 'object' && 'dryRun' in request.json
        ? json(200, connected)
        : json(request.method === 'POST' ? 201 : 200, connector),
    );
    const remote = { name: 'CRM', transport: 'http', url: 'https://mcp.example.com/mcp' } as const;
    await connectors.create({ ...remote, identity });
    await connectors.testDraft({ ...remote, identity });
    await connectors.update(CONNECTOR, { identity });
    await connectors.update(CONNECTOR, { identity: null });
    await connectors.create(remote);
    expect(calls.map((call) => call.json)).toStrictEqual([
      { ...remote, identity },
      { ...remote, identity, dryRun: true },
      { identity },
      { identity: null },
      remote,
    ]);
  });

  it('forwards identity in an openapi create and its dry run, and leaves it out when absent', async () => {
    const { connectors, calls } = client(() => json(201, fixtures.openApiConnector()));
    const body = { kind: 'openapi', name: 'erp', document: DOCUMENT, allow: ['GET /**'] } as const;
    await connectors.create({ ...body, identity });
    await connectors.create(body);
    expect(calls[0]?.json).toStrictEqual({ ...body, identity });
    expect(calls[1]?.json).toStrictEqual(body);
  });
});

// @story US-STO-12
describe('ConnectorsClient and a legacy reserved identity', () => {
  it('[US-STO-12][unit][sdk] reads a connector whose stored identity names a storage connection credential', async () => {
    const legacy = {
      ...connector,
      identity: { secret: 'STORAGE_CONNECTION_77777777777747778777777777777777' },
    };
    const { connectors } = client(() => json(200, legacy));
    expect(await connectors.get(CONNECTOR)).toEqual(legacy);
    const listed = client(() => json(200, { connectors: [legacy] }));
    expect(await listed.connectors.list()).toEqual([legacy]);
  });
});

describe('ConnectorsClient.checkTool (C15, issue #549)', () => {
  const DOCUMENT = '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}';
  const body = {
    kind: 'openapi',
    name: 'orders',
    document: DOCUMENT,
    allow: ['GET /orders/*'],
    auth: 'bearer',
    credential: 'aw-check-placeholder',
  } as const;
  const valid = {
    ok: true,
    kind: 'ok',
    message: 'The openapi connector is valid; nothing was saved.',
    serverName: 'Orders',
    serverVersion: null,
    toolCount: 1,
  };

  it('posts the body with dryRun: true to the collection and reads the 200', async () => {
    const { connectors, calls } = client(() => json(200, valid));
    expect(await connectors.checkTool(body)).toEqual(valid);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/connectors');
    expect(calls[0]?.json).toStrictEqual({ ...body, dryRun: true });
  });

  it('patches the connector it would replace when given its id', async () => {
    const { connectors, calls } = client(() => json(200, valid));
    await connectors.checkTool(body, { connectorId: CONNECTOR });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/api/connectors/${CONNECTOR}`);
    expect(calls[0]?.json).toStrictEqual({ ...body, dryRun: true });
  });

  it('surfaces a refused document as an ApiProblemError with its details', async () => {
    const detail = '$ref "./other.yaml#/X": only references within the document are supported';
    const { connectors } = client(() =>
      json(422, {
        error: { code: 'connector_spec_invalid', message: 'refused', details: [detail] },
      }),
    );
    const failure = await connectors.checkTool(body).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(422);
    expect((failure as ApiProblemError).code).toBe('connector_spec_invalid');
    expect((failure as ApiProblemError).details).toEqual([detail]);
  });
});
