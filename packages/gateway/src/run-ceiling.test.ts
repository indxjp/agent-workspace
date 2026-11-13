import { expect, it } from 'vitest';

import { createAuthenticatedGateway, type GatewayRunResolver, type RunSpend } from './auth.js';
import {
  createRunCeilingAdmission,
  runBudgetReachedMessage,
  spendCeilingReached,
  usdMicros,
} from './run-ceiling.js';
import { createRunTokenCodec } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

import { SUBJECT, SECRET, errorCode } from './auth.fixture.test-support.js';

type Ended = { workspaceId: string; runId: string; error: string };

async function harness(spend: RunSpend, options: { readonly endFails?: boolean } = {}) {
  const tokens = createRunTokenCodec({ secret: SECRET });
  const token = await tokens.issue(SUBJECT);
  const upstream: string[] = [];
  const ended: Ended[] = [];
  const router: GatewayRouter = {
    routes: [],
    fetch: (request) => {
      upstream.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ ok: true }));
    },
  };
  const resolver: GatewayRunResolver = {
    resolve: () =>
      Promise.resolve({
        state: 'active',
        providerId: 'anthropic',
        connectionProvider: 'anthropic',
        credential: 'model-key',
        spend,
      }),
  };
  const gateway = createAuthenticatedGateway(
    router,
    tokens,
    resolver,
    undefined,
    undefined,
    undefined,
    createRunCeilingAdmission({
      endRun(workspaceId, runId, error) {
        if (options.endFails === true) return Promise.reject(new Error('database down'));
        ended.push({ workspaceId, runId, error });
        return Promise.resolve();
      },
    }),
  );
  const call = (path: string) =>
    gateway.fetch(
      new Request(`http://gateway:4000${path}`, {
        method: path === '/v1/models' ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(path === '/v1/models'
          ? {}
          : { body: JSON.stringify({ model: 'claude-fixture', messages: [] }) }),
      }),
    );
  return { call, upstream, ended };
}

it.each(['/v1/messages', '/v1/responses', '/v1/chat/completions'])(
  'refuses %s once cost reaches the ceiling, ends the run once, and never reaches the router',
  async (path) => {
    const { call, upstream, ended } = await harness({
      costUsd: '1.000000',
      ceilingUsd: '1.000000',
    });
    const response = await call(path);
    expect(response.status).toBe(403);
    // One body for every dialect: Anthropic reads `error.type`, OpenAI reads `error.code`.
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'permission_error',
        code: 'run_budget_reached',
        message: 'The run stopped at its spend ceiling of 1 USD.',
      },
    });
    expect(upstream).toEqual([]);
    expect(ended).toEqual([
      {
        workspaceId: SUBJECT.workspaceId,
        runId: SUBJECT.runId,
        error: 'run_budget_reached: The run stopped at its spend ceiling of 1 USD.',
      },
    ]);
  },
);

it('forwards a call below the ceiling, and every call of a run with no ceiling', async () => {
  const below = await harness({ costUsd: '0.999999', ceilingUsd: '1.000000' });
  expect((await below.call('/v1/messages')).status).toBe(200);
  expect(below.upstream).toEqual(['/v1/messages']);
  expect(below.ended).toEqual([]);

  const uncapped = await harness({ costUsd: '9999.000000', ceilingUsd: null });
  expect((await uncapped.call('/v1/responses')).status).toBe(200);
  expect(uncapped.upstream).toEqual(['/v1/responses']);
  expect(uncapped.ended).toEqual([]);
});

it('forwards a path that is not metered even when the run is over its ceiling', async () => {
  const { call, upstream, ended } = await harness({ costUsd: '2.000000', ceilingUsd: '0.5' });
  expect((await call('/v1/models')).status).toBe(200);
  expect(upstream).toEqual(['/v1/models']);
  expect(ended).toEqual([]);
});

it('answers 503 run_budget_unavailable, not 403, when the run end cannot be written', async () => {
  const { call, upstream } = await harness(
    { costUsd: '0.600000', ceilingUsd: '0.500000' },
    { endFails: true },
  );
  const response = await call('/v1/messages');
  expect(response.status).toBe(503);
  expect(await errorCode(response)).toBe('run_budget_unavailable');
  expect(upstream).toEqual([]);
});

it('compares the decimals exactly, as micro-dollars', () => {
  expect(usdMicros('0.1')).toBe(100_000n);
  expect(usdMicros('12.000001')).toBe(12_000_001n);
  expect(spendCeilingReached({ costUsd: '0.300000', ceilingUsd: '0.3' })).toBe(true);
  expect(spendCeilingReached({ costUsd: '0.299999', ceilingUsd: '0.3' })).toBe(false);
  expect(spendCeilingReached({ costUsd: '5', ceilingUsd: null })).toBe(false);
  expect(() => usdMicros('1e3')).toThrow();
  expect(runBudgetReachedMessage('0.500000')).toBe(
    'The run stopped at its spend ceiling of 0.5 USD.',
  );
  expect(runBudgetReachedMessage('100.000000')).toBe(
    'The run stopped at its spend ceiling of 100 USD.',
  );
});
