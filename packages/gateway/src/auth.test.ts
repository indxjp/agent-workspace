import { describe, expect, it } from 'vitest';

import { authenticateGatewayRequest, type GatewayRunResolver } from './auth.js';

import { createRunTokenCodec } from './tokens/run-token.js';

import { SUBJECT, SECRET, errorCode } from './auth.fixture.test-support.js';

describe('gateway run authentication', () => {
  it('refuses a token for run A when run B is requested', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const resolver: GatewayRunResolver = {
      resolve: () => Promise.resolve({ state: 'missing' }),
    };
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${await tokens.issue(SUBJECT)}` },
      }),
      tokens,
      resolver,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(403);
    await expect(errorCode(result.response)).resolves.toBe('token_run_mismatch');
  });

  it('refuses an expired token with its own status and code', async () => {
    let now = 1000;
    const tokens = createRunTokenCodec({ secret: SECRET, ttlSeconds: 60, now: () => now });
    const token = await tokens.issue(SUBJECT);
    now = 1060;
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${token}` },
      }),
      tokens,
      { resolve: () => Promise.resolve({ state: 'missing' }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(401);
    await expect(errorCode(result.response)).resolves.toBe('token_expired');
  });

  it('refuses a token whose run has been deleted with its own status and code', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${await tokens.issue(SUBJECT)}` },
      }),
      tokens,
      { resolve: () => Promise.resolve({ state: 'deleted' }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(410);
    await expect(errorCode(result.response)).resolves.toBe('run_deleted');
  });

  it('refuses an individually revoked token before provider resolution', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${await tokens.issue(SUBJECT)}` },
      }),
      tokens,
      { resolve: () => Promise.resolve({ state: 'revoked' }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(401);
    await expect(errorCode(result.response)).resolves.toBe('token_revoked');
  });
});
