import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { EnginesClient } from './engines.js';

const CAPABILITIES = {
  mcp: true,
  skills: true,
  subagents: false,
  resume: true,
  fork: false,
  interrupt: true,
  streamingText: false,
  reasoning: true,
  maxTurns: 'native',
  maxBudget: 'native',
  wireProtocols: ['anthropic-messages'],
};

const CLAUDE = {
  id: 'claude-agent-sdk',
  displayName: 'Claude Agent SDK',
  version: '0.3.278',
  capabilities: CAPABILITIES,
  installed: true,
};

function problem(status: number, code: string): Response {
  return json(status, { error: { code, message: `${code}.` } });
}

function client(route: (request: RecordedRequest) => Response): {
  readonly engines: EnginesClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com/control',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { engines: new EnginesClient(http), calls: api.calls };
}

describe('EnginesClient.list', () => {
  it('unwraps the envelope and preserves the catalogue order', async () => {
    const { engines, calls } = client(() => json(200, { engines: [CLAUDE] }));

    const listed = await engines.list();

    expect(listed).toEqual([CLAUDE]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/control/api/engines');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
  });

  it('answers an empty list for a deployment that registers nothing', async () => {
    const { engines } = client(() => json(200, { engines: [] }));

    expect(await engines.list()).toEqual([]);
  });

  it('reports the catalogue refusal as a typed problem, not as an empty list', async () => {
    const { engines } = client(() => problem(500, 'engine_catalogue_invalid'));

    const failure = await engines.list().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiProblemError);
    expect(failure).toMatchObject({ status: 500, code: 'engine_catalogue_invalid' });
  });

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [503, 'rbac_runtime_not_configured'],
  ])('reports %i %s as an ApiProblemError', async (status: number, code: string) => {
    const { engines } = client(() => problem(status, code));

    const failure = await engines.list().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiProblemError);
    expect(failure).toMatchObject({ status, code });
  });

  it('refuses a body that is not the published catalogue', async () => {
    // A bare array — the shape a reader of the acceptance criterion might expect — is drift, not
    // a tolerated alternative spelling.
    const { engines } = client(() => json(200, [CLAUDE]));

    await expect(engines.list()).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('refuses a descriptor whose engine id the contracts do not publish', async () => {
    const { engines } = client(() => json(200, { engines: [{ ...CLAUDE, id: 'acp' }] }));

    await expect(engines.list()).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { engines, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });

    const failure = await engines.list({ signal: controller.signal }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
