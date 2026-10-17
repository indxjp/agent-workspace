import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { ModelsClient } from './models.js';

const CONNECTION = '22222222-2222-4222-8222-222222222222';
const ODD_ID = 'id with spaces/and#hash';

const connection = {
  id: CONNECTION,
  name: 'Anthropic',
  provider: 'anthropic',
  config: {},
  hasCredential: true,
  ready: true,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const capabilities = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: true,
  structuredOutput: false,
  contextManagement: false,
  webSearch: false,
  tokenCounting: true,
};

function problem(status: number, code: string): Response {
  return json(status, { error: { code, message: `${code}.` } });
}

function client(route: (request: RecordedRequest) => Response): {
  readonly models: ModelsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com/control',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { models: new ModelsClient(http), calls: api.calls };
}

describe('ModelsClient.connections.list', () => {
  it('unwraps the list from its historical key', async () => {
    const { models, calls } = client(() => json(200, { models: [connection] }));
    const listed = await models.connections.list();
    expect(listed).toEqual([connection]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/control/api/model-connections');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
  });

  it('refuses a body under the key the specification would prefer', async () => {
    const { models } = client(() => json(200, { connections: [connection] }));
    await expect(models.connections.list()).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('surfaces the runtime-not-configured refusal by code', async () => {
    const { models } = client(() => problem(503, 'models_runtime_not_configured'));
    const failure = await models.connections.list().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(503);
    expect((failure as ApiProblemError).code).toBe('models_runtime_not_configured');
  });
});

describe('ModelsClient.connections.get', () => {
  it('percent-encodes the id and reads the bare item', async () => {
    const { models, calls } = client(() => json(200, connection));
    expect(await models.connections.get(ODD_ID)).toEqual(connection);
    expect(calls[0]?.url.pathname).toBe(
      `/control/api/model-connections/${encodeURIComponent(ODD_ID)}`,
    );
  });

  it('reports the not-found and the malformed-id refusals by code', async () => {
    const missing = client(() => problem(404, 'model_connection_not_found'));
    const notFound = await missing.models.connections.get(CONNECTION).catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(ApiProblemError);
    expect((notFound as ApiProblemError).code).toBe('model_connection_not_found');

    const malformed = client(() => problem(400, 'invalid_model_connection_id'));
    const badId = await malformed.models.connections.get('nope').catch((e: unknown) => e);
    expect((badId as ApiProblemError).code).toBe('invalid_model_connection_id');
  });

  it('refuses a response that leaks a credential field as a contract violation', async () => {
    const { models } = client(() => json(200, { ...connection, apiKey: 'sk-live' }));
    const failure = await models.connections.get(CONNECTION).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join(' ')).toContain('apiKey');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { models, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });
    const failure = await models.connections
      .get(CONNECTION, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('ModelsClient.connections.create', () => {
  it('posts the body the route parses and reads the 201', async () => {
    const { models, calls } = client(() =>
      json(201, {
        ...connection,
        provider: 'openai-compatible',
        config: { baseUrl: 'https://llm.example.com/v1' },
      }),
    );
    const created = await models.connections.create({
      name: 'Anthropic',
      provider: 'openai-compatible',
      apiKey: 'sk-live',
      config: { baseUrl: 'https://llm.example.com/v1' },
    });
    expect(created.provider).toBe('openai-compatible');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/control/api/model-connections');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.json).toEqual({
      name: 'Anthropic',
      provider: 'openai-compatible',
      apiKey: 'sk-live',
      config: { baseUrl: 'https://llm.example.com/v1' },
    });
  });

  it('surfaces the name conflict and the invalid body with the server details', async () => {
    const conflict = client(() => problem(409, 'model_connection_name_conflict'));
    const taken = await conflict.models.connections
      .create({ name: 'Anthropic', provider: 'anthropic', apiKey: 'k' })
      .catch((e: unknown) => e);
    expect((taken as ApiProblemError).status).toBe(409);
    expect((taken as ApiProblemError).code).toBe('model_connection_name_conflict');

    const invalid = client(() =>
      json(400, {
        error: {
          code: 'invalid_body',
          message: 'The model connection could not be created.',
          details: ['config.baseUrl is required for the "openai-compatible" provider.'],
        },
      }),
    );
    const refused = await invalid.models.connections
      .create({ name: 'x', provider: 'openai-compatible', apiKey: 'k' })
      .catch((e: unknown) => e);
    expect((refused as ApiProblemError).code).toBe('invalid_body');
    expect((refused as ApiProblemError).details).toEqual([
      'config.baseUrl is required for the "openai-compatible" provider.',
    ]);
  });

  it('surfaces the media-type and malformed-JSON refusals the body reader raises', async () => {
    const media = client(() => problem(415, 'unsupported_media_type'));
    const refused = await media.models.connections
      .create({ name: 'x', provider: 'anthropic', apiKey: 'k' })
      .catch((e: unknown) => e);
    expect((refused as ApiProblemError).code).toBe('unsupported_media_type');

    const malformed = client(() => problem(400, 'malformed_body'));
    const bad = await malformed.models.connections
      .create({ name: 'x', provider: 'anthropic', apiKey: 'k' })
      .catch((e: unknown) => e);
    expect((bad as ApiProblemError).code).toBe('malformed_body');
  });

  it('reports the read-back failure the route answers with a 500', async () => {
    const { models } = client(() => problem(500, 'model_connection_disappeared'));
    const failure = await models.connections
      .create({ name: 'x', provider: 'anthropic', apiKey: 'k' })
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).status).toBe(500);
    expect((failure as ApiProblemError).code).toBe('model_connection_disappeared');
  });
});

describe('ModelsClient.connections.update', () => {
  it('patches only what was given', async () => {
    const { models, calls } = client(() => json(200, { ...connection, name: 'Renamed' }));
    const updated = await models.connections.update(CONNECTION, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/control/api/model-connections/${CONNECTION}`);
    expect(calls[0]?.json).toEqual({ name: 'Renamed' });
  });

  it('surfaces the immutable-provider refusal as the invalid_body the route raises', async () => {
    const { models } = client(() =>
      json(400, {
        error: {
          code: 'invalid_body',
          message: 'The model connection could not be updated.',
          details: ['provider cannot be updated.'],
        },
      }),
    );
    const failure = await models.connections
      .update(CONNECTION, { name: 'x' })
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('invalid_body');
  });

  it('reports a forbidden write by code', async () => {
    const { models } = client(() => problem(403, 'forbidden'));
    const failure = await models.connections
      .update(CONNECTION, { name: 'x' })
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).status).toBe(403);
    expect((failure as ApiProblemError).code).toBe('forbidden');
  });
});

describe('ModelsClient.connections.remove', () => {
  it('reads the 200 outcome with the agents that lost their reference', async () => {
    const { models, calls } = client(() =>
      json(200, {
        deleted: true,
        referencedBy: [{ agentId: '11111111-1111-4111-8111-111111111111', agentName: 'Support' }],
      }),
    );
    const outcome = await models.connections.remove(CONNECTION);
    expect(outcome.referencedBy).toHaveLength(1);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe(`/control/api/model-connections/${CONNECTION}`);
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('refuses a 204 without the outcome, and a not-found by code', async () => {
    const empty = client(() => json(204, null));
    await expect(empty.models.connections.remove(CONNECTION)).rejects.toBeInstanceOf(
      ApiProblemError,
    );
    const missing = client(() => problem(404, 'model_connection_not_found'));
    const failure = await missing.models.connections.remove(CONNECTION).catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('model_connection_not_found');
  });
});

describe('ModelsClient.connections.rotateCredential', () => {
  it('posts the key and resolves on the empty 204', async () => {
    const { models, calls } = client(() => json(204, null));
    await expect(models.connections.rotateCredential(ODD_ID, 'sk-new')).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(
      `/control/api/model-connections/${encodeURIComponent(ODD_ID)}/credential`,
    );
    expect(calls[0]?.json).toEqual({ apiKey: 'sk-new' });
  });

  it('surfaces the invalid body, the not-found, and an unauthenticated caller', async () => {
    for (const [status, code] of [
      [400, 'invalid_body'],
      [404, 'model_connection_not_found'],
      [401, 'unauthenticated'],
    ] as const) {
      const { models } = client(() => problem(status, code));
      const failure = await models.connections
        .rotateCredential(CONNECTION, 'k')
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('treats a 200 with a body as a problem: the route promised to say nothing', async () => {
    const { models } = client(() => json(200, { apiKey: 'sk-new' }));
    const failure = await models.connections
      .rotateCredential(CONNECTION, 'sk-new')
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('unrecognised_error_body');
  });
});

describe('ModelsClient.connections.test', () => {
  it('resolves a reachable provider from the 200', async () => {
    const { models, calls } = client(() =>
      json(200, { ok: true, status: 200, latencyMs: 42, message: 'Connection succeeded.' }),
    );
    const outcome = await models.connections.test(CONNECTION);
    expect(outcome).toEqual({
      ok: true,
      status: 200,
      latencyMs: 42,
      message: 'Connection succeeded.',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/control/api/model-connections/${CONNECTION}/test`);
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('resolves, not throws, on the 502 that carries a failed outcome', async () => {
    const { models } = client(() =>
      json(502, {
        ok: false,
        status: null,
        latencyMs: 3000,
        message: 'The provider connection could not be reached.',
      }),
    );
    const outcome = await models.connections.test(CONNECTION);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBeNull();
  });

  it('refuses a 502 from something other than the route as a contract violation', async () => {
    const { models } = client(
      () => new Response('<html>Bad Gateway</html>', { status: 502, headers: {} }),
    );
    const failure = await models.connections.test(CONNECTION).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).status).toBe(502);
  });

  it('still surfaces a not-found and a malformed id as problems', async () => {
    const missing = client(() => problem(404, 'model_connection_not_found'));
    const failure = await missing.models.connections.test(CONNECTION).catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('model_connection_not_found');
    const malformed = client(() => problem(400, 'invalid_model_connection_id'));
    const badId = await malformed.models.connections.test('x').catch((e: unknown) => e);
    expect((badId as ApiProblemError).code).toBe('invalid_model_connection_id');
  });
});

describe('ModelsClient.discover', () => {
  it('reads the catalog and the unavailable list when present', async () => {
    const { models, calls } = client(() =>
      json(200, {
        models: [
          {
            connectionId: CONNECTION,
            providerModelId: 'claude-sonnet-5',
            displayName: 'Claude Sonnet 5',
            capabilities,
          },
        ],
        unavailable: [
          {
            connectionId: '33333333-3333-4333-8333-333333333333',
            connectionName: 'Azure',
            reason: 'The provider model catalog could not be loaded.',
          },
        ],
      }),
    );
    const catalog = await models.discover();
    expect(catalog.models[0]?.providerModelId).toBe('claude-sonnet-5');
    expect(catalog.unavailable?.[0]?.connectionName).toBe('Azure');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/control/api/models');
  });

  it('leaves unavailable absent when the server omitted it', async () => {
    const { models } = client(() => json(200, { models: [] }));
    const catalog = await models.discover();
    expect(catalog.models).toEqual([]);
    expect(catalog.unavailable).toBeUndefined();
  });

  it('refuses a row missing a capability as a contract violation', async () => {
    const { models } = client(() =>
      json(200, {
        models: [
          {
            connectionId: CONNECTION,
            providerModelId: 'm',
            displayName: 'M',
            capabilities: { ...capabilities, thinking: undefined },
          },
        ],
      }),
    );
    await expect(models.discover()).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { models } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });
    const failure = await models.discover({ signal: controller.signal }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});
