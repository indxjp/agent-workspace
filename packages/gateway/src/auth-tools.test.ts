import { describe, expect, it } from 'vitest';

import { createAuthenticatedGateway, verifyRunToken, type GatewayUsageRecord } from './auth.js';

import { createRunTokenCodec } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

import { SUBJECT, SECRET } from './auth.fixture.test-support.js';

describe('seam check 2: the tool route needs no model key and is never metered', () => {
  const TOOL_PATH = 'http://gateway/v1/tools/66666666-6666-4666-8666-666666666666/mcp';

  it('verifies a run token from the codec alone, with nothing resolved', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET });
    const token = await tokens.issue(SUBJECT);
    const verified = await verifyRunToken(
      new Request(TOOL_PATH, { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
      tokens,
    );
    expect(verified).toMatchObject({ ok: true, claims: SUBJECT });
    if (!verified.ok) throw new Error('expected a verified token');
    expect(verified.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('records no usage for a tool path even behind the authenticated model boundary', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET });
    const token = await tokens.issue(SUBJECT);
    const recorded: GatewayUsageRecord[] = [];
    const failed: string[] = [];
    const router: GatewayRouter = {
      routes: [],
      fetch: () => Promise.resolve(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } })),
    };
    const gateway = createAuthenticatedGateway(
      router,
      tokens,
      {
        resolve: () =>
          Promise.resolve({
            state: 'active',
            providerId: 'anthropic',
            connectionProvider: 'anthropic',
            credential: 'model-key',
          }),
      },
      {
        record(usage) {
          recorded.push(usage);
          return Promise.resolve();
        },
        fail(runId) {
          failed.push(runId);
          return Promise.resolve();
        },
      },
    );
    const response = await gateway.fetch(
      new Request(TOOL_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(recorded).toEqual([]);
    expect(failed).toEqual([]);
  });
});
