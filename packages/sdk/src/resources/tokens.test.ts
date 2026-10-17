import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { TokensClient } from './tokens.js';

const problem = (status: number, code: string) => json(status, { error: { code, message: code } });

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly tokens: TokensClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { tokens: new TokensClient(http), calls: api.calls };
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

/** Ids the wire contract accepts: `TokenScopeSchema.id` is a `UuidSchema`. */
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

const MINT_RESPONSE = {
  token: `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`,
  scope: { kind: 'run', id: RUN_ID },
  expiresAt: '2026-01-01T00:05:00.000Z',
  warning: 'shown once',
};

describe('TokensClient.mint (issue #236, SDK-04, S-1)', () => {
  it('POSTs the scope, omits ttlSeconds when not given, and returns the mint response', async () => {
    const { tokens, calls } = client(() => json(201, MINT_RESPONSE));
    const minted = await tokens.mint({ kind: 'run', id: RUN_ID });
    expect(minted).toEqual(MINT_RESPONSE);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe('https://aw.example.com/api/tokens');
    expect(call?.json).toEqual({ scope: { kind: 'run', id: RUN_ID } });
  });

  it('sends ttlSeconds when given', async () => {
    const { tokens, calls } = client(() => json(201, MINT_RESPONSE));
    await tokens.mint({ kind: 'session', id: SESSION_ID }, { ttlSeconds: 600 });
    expect(calls[0]?.json).toEqual({
      scope: { kind: 'session', id: SESSION_ID },
      ttlSeconds: 600,
    });
  });

  it('surfaces forbidden (Viewer), out-of-scope and not-found problems by code', async () => {
    const forbidden = client(() => problem(403, 'forbidden'));
    expectProblem(
      await failure(forbidden.tokens.mint({ kind: 'run', id: RUN_ID })),
      403,
      'forbidden',
    );
    const outOfScope = client(() => problem(403, 'token_out_of_scope'));
    expectProblem(
      await failure(outOfScope.tokens.mint({ kind: 'run', id: RUN_ID })),
      403,
      'token_out_of_scope',
    );
    const notFound = client(() => problem(404, 'run_not_found'));
    expectProblem(
      await failure(notFound.tokens.mint({ kind: 'run', id: RUN_ID })),
      404,
      'run_not_found',
    );
  });

  it('refuses a 201 whose body drifted from MintTokenResponseSchema', async () => {
    const { tokens } = client(() => json(201, { ...MINT_RESPONSE, token: 'not-a-token' }));
    const drift = await failure(tokens.mint({ kind: 'run', id: RUN_ID }));
    expect(drift).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { tokens, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const aborted = await failure(
      tokens.mint({ kind: 'run', id: RUN_ID }, { signal: controller.signal }),
    );
    expect(aborted).toBeInstanceOf(TransportError);
    expect((aborted as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
