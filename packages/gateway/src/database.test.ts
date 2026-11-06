import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openDatabaseRoot,
  type DatabaseRoot,
  type RecordRunUsageInput,
  type RecordRunUsageOutcome,
  type RunRecord,
  type RunRepository,
  type RunTransitionOutcome,
  type WorkspaceScope,
} from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { SecretsService } from '@agent-workspace/core/secrets';

import { createAuthenticatedGateway, firstRefusalOf, type GatewayUsageRecord } from './auth.js';
import {
  createDatabaseDailyCostLedger,
  createDatabaseGatewayRunResolver,
  createDatabaseUsageRecorder,
} from './database.js';
import { parsePricingCatalog } from './pricing.js';
import { createRunCeilingAdmission } from './run-ceiling.js';
import { createRunTokenCodec } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[gateway/database.test.ts] SKIPPED the PostgreSQL case — TEST_DATABASE_URL is not set, so ' +
      'the run spend ceiling against a real PostgreSQL was NOT exercised.',
  );
}

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
    findByIdempotencyKey: () => {
      throw new Error('not used by this fixture');
    },
    markRunning: () => {
      throw new Error('not used by this fixture');
    },
    consumeApprovedCall: () => {
      throw new Error('not used by this fixture');
    },
    awaitApproval: () => {
      throw new Error('not used by this fixture');
    },
    finish: () => {
      throw new Error('not used by this fixture');
    },
    snapshotModel: () => {
      throw new Error('not used by this fixture');
    },
    listRuns: () => {
      throw new Error('not used by this fixture');
    },
    listChildren: () => {
      throw new Error('not used by this fixture');
    },
    usageCostUsd: () => {
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

describe('createDatabaseDailyCostLedger', () => {
  const WORKSPACE = 'workspace-cap-1';
  const ledgerOver = (scope: string | null) => {
    const calls: unknown[][] = [];
    const database = {
      scopes: { forWorkspaceId: () => Promise.resolve(scope) },
      runs: {
        forScope: (used: unknown) => ({
          usageCostUsd: (...args: unknown[]) => {
            calls.push(['usageCostUsd', used, ...args]);
            return Promise.resolve({ costUsd: '3', unpricedUsage: false });
          },
          finish: (...args: unknown[]) => {
            calls.push(['finish', used, ...args]);
            return Promise.resolve({ kind: 'no-op' });
          },
        }),
      },
    } as unknown as DatabaseRoot;
    return { ledger: createDatabaseDailyCostLedger(database), calls };
  };

  it('reads the ledger sum and ends the run as failed with a status event, inside the workspace scope', async () => {
    const { ledger, calls } = ledgerOver('scope-1');
    const from = new Date('2026-10-27T00:00:00Z');
    const to = new Date('2026-10-28T00:00:00Z');

    await expect(ledger.sumCostUsd(WORKSPACE, from, to)).resolves.toEqual({
      costUsd: '3',
      unpricedUsage: false,
    });
    await ledger.endRun(WORKSPACE, 'run-1', 'daily_cost_cap_reached: stopped');

    expect(calls).toEqual([
      ['usageCostUsd', 'scope-1', from, to],
      [
        'finish',
        'scope-1',
        'run-1',
        'failed',
        'daily_cost_cap_reached: stopped',
        Number.MAX_SAFE_INTEGER,
      ],
    ]);
  });

  it('rejects, rather than reading unscoped, when the workspace does not resolve', async () => {
    const { ledger, calls } = ledgerOver(null);
    await expect(ledger.sumCostUsd(WORKSPACE, new Date(), new Date())).rejects.toThrow(
      /did not resolve/u,
    );
    await expect(ledger.endRun(WORKSPACE, 'run-1', 'x')).rejects.toThrow(/did not resolve/u);
    expect(calls).toEqual([]);
  });
});

/**
 * The run spend ceiling end to end over a real PostgreSQL (ADR-0162): the real resolver reads the
 * run's cost and ceiling, the real recorder settles each response into `runs.cost_usd`, and the
 * real ledger ends the run. Only the provider (a stub router) and the secret store are doubles.
 */
describe.skipIf(!hasDatabase)('the run spend ceiling over a real PostgreSQL (ADR-0162)', () => {
  const ids = {
    workspace: crypto.randomUUID(),
    user: crypto.randomUUID(),
    membership: crypto.randomUUID(),
    principal: '',
    agent: crypto.randomUUID(),
    session: crypto.randomUUID(),
    connection: crypto.randomUUID(),
    run: crypto.randomUUID(),
  };
  const PRICING = parsePricingCatalog(
    JSON.stringify({
      version: 'prices-ceiling',
      models: {
        'anthropic:claude-fixture': { inputUsdPerMillion: '3', outputUsdPerMillion: '15' },
      },
    }),
  );
  // Each response costs 100 × 3/1M + 20 × 15/1M = 0.000600 USD, so two cross 0.001 USD.
  const CEILING = '0.001000';
  let isolated: IsolatedTestDatabase;
  let pool: pg.Pool;
  let database: DatabaseRoot | undefined;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_run_ceiling');
    pool = new pg.Pool({ connectionString: isolated.url, max: 2 });
    await pool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'Ceiling')`, [
      ids.workspace,
      `ceiling-${ids.workspace.slice(0, 8)}`,
    ]);
    await pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')`, [
      ids.user,
      `${ids.user}@example.com`,
    ]);
    await pool.query(
      `INSERT INTO memberships (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
      [ids.membership, ids.workspace, ids.user],
    );
    // A membership's principal is created with it.
    const principal = await pool.query<{ id: string }>(
      'SELECT id FROM workspace_principals WHERE membership_id = $1',
      [ids.membership],
    );
    ids.principal = principal.rows[0]?.id ?? '';
    await pool.query(
      `INSERT INTO agents (id, workspace_id, name, instructions, permissions, owner_principal_id)
       VALUES ($1, $2, 'Ceiling agent', '', $3::jsonb, $4)`,
      [
        ids.agent,
        ids.workspace,
        JSON.stringify({
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        }),
        ids.principal,
      ],
    );
    await pool.query(
      `INSERT INTO sessions (id, workspace_id, owner_principal_id, agent_id) VALUES ($1, $2, $3, $4)`,
      [ids.session, ids.workspace, ids.principal, ids.agent],
    );
    await pool.query(
      `INSERT INTO model_connections (id, workspace_id, name, provider, config)
       VALUES ($1, $2, 'default', 'anthropic', '{}'::jsonb)`,
      [ids.connection, ids.workspace],
    );
    await pool.query(
      `INSERT INTO runs (id, workspace_id, session_id, status, started_at, spend_ceiling_usd)
       VALUES ($1, $2, $3, 'running', now(), $4)`,
      [ids.run, ids.workspace, ids.session, CEILING],
    );
    database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await database?.close();
    await pool.end();
    await isolated.close();
  });

  it('settles two responses that cross the ceiling, refuses the third, and ends the run run_budget_reached', async () => {
    const tokens = createRunTokenCodec({
      secret: 'ceiling-fixture-signing-secret-of-32-bytes-or-more',
    });
    const token = await tokens.issue({
      runId: ids.run,
      sessionId: ids.session,
      workspaceId: ids.workspace,
      agentId: ids.agent,
      modelConnectionId: ids.connection,
    });
    const verified = await tokens.verify(token);
    if (!verified.ok) throw new Error('the fixture token did not verify');
    if (database === undefined) throw new Error('the database root did not open');
    await pool.query(
      `INSERT INTO run_tokens (id, run_id, workspace_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [
        verified.claims.tokenId,
        ids.run,
        ids.workspace,
        createHash('sha256').update(token).digest('hex'),
      ],
    );
    const secrets = {
      resolveByName: () => Promise.resolve({ value: Buffer.from('provider-fixture-key') }),
    } as unknown as SecretsService;
    let served = 0;
    const router: GatewayRouter = {
      routes: [],
      fetch: () => {
        served += 1;
        return Promise.resolve(
          Response.json({
            id: `msg_ceiling_${String(served)}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-fixture',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
        );
      },
    };
    const usageErrors: unknown[] = [];
    const gateway = createAuthenticatedGateway(
      router,
      tokens,
      createDatabaseGatewayRunResolver(database, secrets),
      createDatabaseUsageRecorder(database, PRICING),
      (error) => usageErrors.push(error),
      undefined,
      firstRefusalOf([createRunCeilingAdmission(createDatabaseDailyCostLedger(database))]),
    );
    const call = () =>
      gateway.fetch(
        new Request('http://gateway:4000/v1/messages', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-fixture', max_tokens: 16, messages: [] }),
        }),
      );

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(usageErrors).toEqual([]);
    const third = await call();
    expect(third.status).toBe(403);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      'run_budget_reached',
    );
    expect(served).toBe(2);

    const row = await pool.query<{ status: string; error: string; cost_usd: string }>(
      'SELECT status, error, cost_usd::text AS cost_usd FROM runs WHERE id = $1',
      [ids.run],
    );
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.cost_usd).toBe('0.001200');
    expect(row.rows[0]?.error.startsWith('run_budget_reached: ')).toBe(true);
    expect(row.rows[0]?.error).toBe(
      'run_budget_reached: The run stopped at its spend ceiling of 0.001 USD.',
    );

    // The run is terminal now: its next call is refused as a revoked token, and the error stays.
    expect((await call()).status).toBe(401);
    expect(served).toBe(2);
  });
});
