import { describe, expect, it } from 'vitest';

import { checkReadiness, ReadinessRefusal } from './readiness.ts';

const TOKEN = 'operator-token-that-must-never-be-printed-0123456789';
const env = { STORE_PLATFORM_URL: 'https://app.agents.indx.example', STORE_OPERATOR_TOKEN: TOKEN };

function answering(status: number, body: unknown): { fetcher: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetcher = ((input: URL, init: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(Response.json(body, { status }));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe('the Anthropic key readiness check', () => {
  it('asks GET /api/demo/readiness with the operator bearer and returns the two booleans', async () => {
    const { fetcher, calls } = answering(200, { apiKeyConfigured: true, apiReachable: true });
    await expect(checkReadiness(env, fetcher)).resolves.toEqual({
      apiKeyConfigured: true,
      apiReachable: true,
    });
    expect(calls[0]?.method).toBe('GET');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/api/demo/readiness');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('reports a key that is configured but unreachable as it is, for the caller to fail on', async () => {
    const { fetcher } = answering(200, { apiKeyConfigured: true, apiReachable: false });
    await expect(checkReadiness(env, fetcher)).resolves.toEqual({
      apiKeyConfigured: true,
      apiReachable: false,
    });
  });

  it('refuses a wrong token, an unset variable, a non-https origin and an unexpected answer', async () => {
    await expect(checkReadiness(env, answering(401, { title: 'no' }).fetcher)).rejects.toThrow(
      'the readiness route answered 401',
    );
    await expect(checkReadiness({ ...env, STORE_OPERATOR_TOKEN: '' })).rejects.toThrow(
      'STORE_OPERATOR_TOKEN is not set',
    );
    await expect(
      checkReadiness({ ...env, STORE_PLATFORM_URL: 'http://app.agents.indx.example' }),
    ).rejects.toThrow('must be https');
    await expect(
      checkReadiness(env, answering(200, { apiKeyConfigured: true, key: 'sk-x' }).fetcher),
    ).rejects.toThrow('not the expected shape');
  });

  it('never carries the token in a refusal, even when the transport fails with it', async () => {
    const failing = (() => Promise.reject(new Error(`boom ${TOKEN}`))) as unknown as typeof fetch;
    const error = await checkReadiness(env, failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReadinessRefusal);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});
