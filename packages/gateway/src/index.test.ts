import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseRoot,
  RecordRunUsageInput,
  RecordRunUsageOutcome,
  RunRecord,
  RunRepository,
  RunTransitionOutcome,
  WorkspaceScope,
} from '@agent-workspace/core/db';

import { createRunTokenCodec } from './tokens/run-token.js';
import {
  createDatabaseUsageRecorder,
  createGatewayApplication,
  PACKAGE_NAME,
  startGateway,
  type GatewayUsageRecord,
} from './index.js';
import { parsePricingCatalog } from './pricing.js';

const TOKEN_SECRET = 'wave-4-integration-token-secret-0001';

describe('@agent-workspace/gateway', () => {
  it('is wired into the pnpm workspace', () => {
    expect(PACKAGE_NAME).toBe('@agent-workspace/gateway');
  });

  it('keeps health public but requires a signed run token for model routes', async () => {
    const gateway = createGatewayApplication({
      tokenSecret: TOKEN_SECRET,
      resolver: { resolve: () => Promise.resolve({ state: 'missing' }) },
    });
    expect(await (await gateway.fetch(new Request('http://gateway/health'))).json()).toEqual({
      status: 'ok',
    });
    expect((await gateway.fetch(new Request('http://gateway/v1/models'))).status).toBe(401);
  });

  it('feeds the registry to the router and selects endpoint settings from the signed run', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: 'fixture refusal', type: 'invalid_request_error', code: 'fixture' } },
          { status: 400 },
        ),
      );
    const gateway = createGatewayApplication({
      tokenSecret: TOKEN_SECRET,
      providers: { fetch: upstream },
      resolver: {
        resolve: () =>
          Promise.resolve({
            state: 'active',
            providerId: 'openai',
            connectionProvider: 'openai',
            credential: 'provider-secret',
            settings: { baseUrl: 'http://localhost:9400/v1' },
          }),
      },
    });
    const codec = createRunTokenCodec({ secret: TOKEN_SECRET });
    const token = await codec.issue({
      runId: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      modelConnectionId: 'connection-1',
    });
    const response = await gateway.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-fixture', max_tokens: 32, messages: [] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[0]).toBe('http://localhost:9400/v1/responses');
    const init = upstream.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
  });

  it.each(['4000garbage', '12.5', ' 4000', '4000 '])(
    'rejects PORT when the complete value is not an integer: %s',
    async (port) => {
      await expect(
        startGateway({ GATEWAY_TOKEN_SECRET: TOKEN_SECRET, PORT: port }),
      ).rejects.toThrow('PORT must be an integer from 1 through 65535.');
    },
  );
});

/**
 * A minimal in-memory {@link DatabaseRoot} double, standing in for the real PostgreSQL-backed one
 * — that repository behaviour is proven against a live database in
 * `packages/core/src/db/repositories/run-usage.test.ts`. What is under test here is
 * {@link createDatabaseUsageRecorder}'s own logic: catching a missing catalogue price and its
 * generic settlement-failure wrapper, neither of which this task's schema/repository layer knows
 * about on its own.
 */
function fakeDatabaseRoot(
  runId: string,
  workspaceId: string,
): {
  readonly database: DatabaseRoot;
  readonly recordUsageCalls: RecordRunUsageInput[];
  readonly markAccountingFailedCalls: { runId: string; reason: string }[];
  recordUsageResult: RecordRunUsageOutcome;
} {
  const run: RunRecord = {
    id: runId,
    workspaceId,
    agentId: 'agent-1',
    sessionId: 'session-1',
    status: 'running',
    createdAt: new Date(),
    startedAt: new Date(),
    endedAt: null,
    model: null,
    provider: null,
    modelConnectionId: null,
    engine: 'claude-agent-sdk',
    engineVersion: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolCalls: 0,
    costUsd: '0.000000',
    costCurrency: 'USD',
    priceTableVersion: null,
    error: null,
    accountingState: 'pending',
    accountingError: null,
  };
  const recordUsageCalls: RecordRunUsageInput[] = [];
  const markAccountingFailedCalls: { runId: string; reason: string }[] = [];
  const state = { recordUsageResult: { kind: 'recorded', run } as RecordRunUsageOutcome };
  const repository: RunRepository = {
    create: () => {
      throw new Error('not used by this fixture');
    },
    get: () => Promise.resolve(run),
    markRunning: () => {
      throw new Error('not used by this fixture');
    },
    finish: () => {
      throw new Error('not used by this fixture');
    },
    snapshotModel: () => {
      throw new Error('not used by this fixture');
    },
    recordUsage: (_runId, input) => {
      recordUsageCalls.push(input);
      return Promise.resolve(state.recordUsageResult);
    },
    markAccountingFailed: (id, reason): Promise<RunTransitionOutcome> => {
      markAccountingFailedCalls.push({ runId: id, reason });
      return Promise.resolve({ kind: 'moved', run: { ...run, accountingState: 'failed' } });
    },
  };
  const database = {
    findRunWorkspace: (id: string) => Promise.resolve(id === runId ? workspaceId : null),
    scopes: { forWorkspaceId: () => Promise.resolve('fake-scope' as unknown as WorkspaceScope) },
    runs: { forScope: () => repository },
  } as unknown as DatabaseRoot;
  return {
    database,
    recordUsageCalls,
    markAccountingFailedCalls,
    get recordUsageResult() {
      return state.recordUsageResult;
    },
    set recordUsageResult(value: RecordRunUsageOutcome) {
      state.recordUsageResult = value;
    },
  };
}

describe('createDatabaseUsageRecorder', () => {
  const RUN_ID = 'run-usage-1';
  const WORKSPACE_ID = 'workspace-usage-1';
  const PRICED_CATALOG = parsePricingCatalog(
    JSON.stringify({
      version: 'prices-fixture',
      models: {
        'anthropic:claude-fixture': { inputUsdPerMillion: '3', outputUsdPerMillion: '15' },
      },
    }),
  );

  const usage = {
    runId: RUN_ID,
    providerResponseId: 'msg_1',
    provider: 'anthropic',
    model: 'claude-fixture',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolCalls: 0,
    wireProtocol: 'anthropic-messages',
    metered: true,
  } as const satisfies GatewayUsageRecord;

  it('settles a captured response at an actual, priced cost when the catalogue covers it', async () => {
    const fake = fakeDatabaseRoot(RUN_ID, WORKSPACE_ID);
    const recorder = createDatabaseUsageRecorder(fake.database, PRICED_CATALOG);
    await recorder.record(usage);
    expect(fake.recordUsageCalls).toEqual([
      expect.objectContaining({ priceTableVersion: 'prices-fixture', costUsd: '0.000600' }),
    ]);
  });

  it('settles a captured response with no price entry as zero cost and a null price version, never throwing', async () => {
    const fake = fakeDatabaseRoot(RUN_ID, WORKSPACE_ID);
    const unpricedCatalog = parsePricingCatalog(
      JSON.stringify({
        version: 'prices-fixture',
        models: { 'openai:*': { inputUsdPerMillion: '1', outputUsdPerMillion: '1' } },
      }),
    );
    const recorder = createDatabaseUsageRecorder(fake.database, unpricedCatalog);
    await recorder.record(usage); // model is anthropic:claude-fixture — not in this catalogue
    expect(fake.recordUsageCalls).toEqual([
      expect.objectContaining({ priceTableVersion: null, costUsd: '0.000000' }),
    ]);
    // A missing price is not a settlement failure: no failure mark is written.
    expect(fake.markAccountingFailedCalls).toEqual([]);
  });

  it('prices an anthropic-compatible record under its own key, not the anthropic row', async () => {
    const fake = fakeDatabaseRoot(RUN_ID, WORKSPACE_ID);
    const anthropicOnly = parsePricingCatalog(
      JSON.stringify({
        version: 'prices-fixture',
        models: { 'anthropic:*': { inputUsdPerMillion: '3', outputUsdPerMillion: '15' } },
      }),
    );
    const recorder = createDatabaseUsageRecorder(fake.database, anthropicOnly);
    await recorder.record({ ...usage, provider: 'anthropic-compatible' });
    expect(fake.recordUsageCalls).toEqual([
      expect.objectContaining({
        provider: 'anthropic-compatible',
        priceTableVersion: null,
        costUsd: '0.000000',
      }),
    ]);
  });

  it('marks the run failed and rethrows when the repository refuses the settlement', async () => {
    const fake = fakeDatabaseRoot(RUN_ID, WORKSPACE_ID);
    fake.recordUsageResult = { kind: 'not-found' };
    const recorder = createDatabaseUsageRecorder(fake.database, PRICED_CATALOG);
    await expect(recorder.record(usage)).rejects.toThrow(/missing run/u);
    expect(fake.markAccountingFailedCalls).toHaveLength(1);
    expect(fake.markAccountingFailedCalls[0]?.runId).toBe(RUN_ID);
    expect(fake.markAccountingFailedCalls[0]?.reason).toContain('missing run');
  });

  it('fail() marks the run failed directly, for a response that could not be parsed at all', async () => {
    const fake = fakeDatabaseRoot(RUN_ID, WORKSPACE_ID);
    const recorder = createDatabaseUsageRecorder(fake.database, PRICED_CATALOG);
    await recorder.fail(RUN_ID, 'provider response contained no authoritative usage fields');
    expect(fake.markAccountingFailedCalls).toEqual([
      { runId: RUN_ID, reason: 'provider response contained no authoritative usage fields' },
    ]);
  });
});
