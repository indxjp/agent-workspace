import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
} from '@indx-workspace/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ApiProblemError,
  ContractsVersionUnsupportedError,
  ContractViolationError,
} from './errors.js';
import { HttpClient } from './http.js';
import { fetchDouble, jsonResponse } from './testing.js';
import { readContractsVersionSkew } from './version.js';

function served(current: string, minimum: string): Headers {
  return new Headers({
    [CONTRACTS_VERSION_HEADER]: current,
    [CONTRACTS_MINIMUM_VERSION_HEADER]: minimum,
  });
}

describe('readContractsVersionSkew', () => {
  it('is null when the range is served', () => {
    expect(readContractsVersionSkew(served('1.3.0', '1.2.0'), '1.2.5')).toBeNull();
    expect(readContractsVersionSkew(served(CONTRACTS_VERSION, CONTRACTS_VERSION))).toBeNull();
  });

  it('names both versions and asks the client to upgrade when it is older than the minimum', () => {
    expect(readContractsVersionSkew(served('1.3.0', '1.2.0'), '1.1.0')).toEqual({
      clientVersion: '1.1.0',
      serverVersion: '1.3.0',
      servedMinimum: '1.2.0',
      upgrade: 'client',
    });
  });

  it('asks the server to upgrade when the client is newer than it', () => {
    expect(readContractsVersionSkew(served('1.3.0', '1.2.0'), '2.0.0')?.upgrade).toBe('server');
  });

  it('is null when the response carries no readable range', () => {
    expect(readContractsVersionSkew(new Headers(), '9.9.9')).toBeNull();
    expect(readContractsVersionSkew(served('latest', '1.0.0'), '9.9.9')).toBeNull();
  });
});

describe('the client negotiates the contracts version (issue #244, S-7)', () => {
  const Echo = z.object({ ok: z.literal(true) }).strict();

  it('sends its contracts version on every request, and a caller header cannot override it', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: true }));
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'acme',
      headers: { [CONTRACTS_VERSION_HEADER]: '0.0.0' },
      fetch: api.fetch,
    });
    await client.json({
      operation: 'echo',
      method: 'POST',
      path: '/api/echo',
      body: {},
      expect: [200],
      schema: Echo,
      headers: { [CONTRACTS_VERSION_HEADER]: '0.0.0' },
    });

    expect(api.calls.map((call) => call.url.pathname)).toEqual([
      '/api/auth/workspace',
      '/api/echo',
    ]);
    for (const call of api.calls) {
      expect(call.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
    }
  });

  it('surfaces a 426 as the typed ContractsVersionUnsupportedError with both versions', async () => {
    const message = `This client was built against contracts ${CONTRACTS_VERSION}; this server serves contracts 2.0.0 to 2.1.0.`;
    const api = fetchDouble(() =>
      jsonResponse(
        426,
        { error: { code: 'contracts_version_unsupported', message, detail: message } },
        { [CONTRACTS_VERSION_HEADER]: '2.1.0', [CONTRACTS_MINIMUM_VERSION_HEADER]: '2.0.0' },
      ),
    );
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: api.fetch,
    });
    const failure: unknown = await client
      .json({ operation: 'echo', method: 'GET', path: '/api/echo', expect: [200], schema: Echo })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ContractsVersionUnsupportedError);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const refusal = failure as ContractsVersionUnsupportedError;
    expect(refusal.status).toBe(426);
    expect(refusal.code).toBe('contracts_version_unsupported');
    expect(refusal.message).toBe(message);
    expect(refusal.skew).toEqual({
      clientVersion: CONTRACTS_VERSION,
      serverVersion: '2.1.0',
      servedMinimum: '2.0.0',
      upgrade: 'client',
    });
  });

  it('keeps a 426 without the range typed, with no skew to report', async () => {
    const api = fetchDouble(() =>
      jsonResponse(426, { error: { code: 'contracts_version_unsupported', message: 'No.' } }),
    );
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: api.fetch,
    });
    const failure: unknown = await client
      .send({ operation: 'echo', method: 'GET', path: '/api/echo', expect: [200] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ContractsVersionUnsupportedError);
    expect((failure as ContractsVersionUnsupportedError).skew).toBeNull();
  });

  it('names the contracts version in a contract violation', () => {
    const violation = new ContractViolationError({ operation: 'echo', status: 200, issues: ['$'] });
    expect(violation.contractsVersion).toBe(CONTRACTS_VERSION);
    expect(violation.message).toContain(`contracts ${CONTRACTS_VERSION}`);
  });
});
