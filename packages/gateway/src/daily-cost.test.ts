import { parseRunFailure } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { createAuthenticatedGateway, type GatewayRunResolver } from './auth.js';
import {
  createDailyCostAdmission,
  type DailyCostErrorContext,
  type DailyCostLedger,
} from './daily-cost.js';
import { createGatewayApplication } from './index.js';
import { createRunTokenCodec, type RunTokenSubject } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

const SUBJECT: RunTokenSubject = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '55555555-5555-4555-8555-555555555555',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  modelConnectionId: '44444444-4444-4444-8444-444444444444',
};
const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';
const NOON = new Date('2026-10-27T12:00:00.000Z');

type Window = { costUsd: string; unpricedUsage: boolean };

/** A ledger that answers `window` (or rejects), and records every read and every ended run. */
function fakeLedger(window: Window | Error = { costUsd: '0', unpricedUsage: false }) {
  const reads: { workspaceId: string; from: Date; to: Date }[] = [];
  const ended: { workspaceId: string; runId: string; error: string }[] = [];
  const state = { window };
  const ledger: DailyCostLedger = {
    sumCostUsd(workspaceId, from, to) {
      reads.push({ workspaceId, from, to });
      return state.window instanceof Error
        ? Promise.reject(state.window)
        : Promise.resolve(state.window);
    },
    endRun(workspaceId, runId, error) {
      ended.push({ workspaceId, runId, error });
      return Promise.resolve();
    },
  };
  return { ledger, reads, ended, state };
}

/** Active until the ledger has ended the run, then revoked: the database revokes a run's tokens in the transaction that stops it. */
function resolverOver(ended: readonly { runId: string }[]): GatewayRunResolver {
  return {
    resolve: ({ runId }) =>
      Promise.resolve(
        ended.some((run) => run.runId === runId)
          ? { state: 'revoked' }
          : {
              state: 'active',
              providerId: 'anthropic',
              connectionProvider: 'anthropic',
              credential: 'provider-master-key',
            },
      ),
  };
}

/** The harness a model call goes through: real token codec, real admission, a counting router. */
async function harness(options: {
  readonly window?: Window | Error;
  readonly cap?: number;
  readonly path?: string;
}) {
  const fake = fakeLedger(options.window);
  const tokens = createRunTokenCodec({ secret: SECRET });
  const token = await tokens.issue({
    ...SUBJECT,
    ...(options.cap === undefined ? {} : { dailyCostCapUsd: options.cap }),
  });
  const upstream: string[] = [];
  const router: GatewayRouter = {
    routes: [],
    fetch: (request) => {
      upstream.push(request.url);
      return Promise.resolve(Response.json({ ok: true }));
    },
  };
  const gateway = createAuthenticatedGateway(
    router,
    tokens,
    resolverOver(fake.ended),
    undefined,
    undefined,
    undefined,
    createDailyCostAdmission(fake.ledger, { now: () => NOON }),
  );
  const call = (path = options.path ?? '/v1/messages') =>
    gateway.fetch(
      new Request(`http://gateway:4000${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-fixture', messages: [] }),
      }),
    );
  return { ...fake, call, upstream };
}

async function problemOf(response: Response) {
  return ((await response.json()) as { error: { type: string; code: string; message: string } })
    .error;
}

describe('the daily cost cap at model-call admission (issue #1851, slice 3b)', () => {
  it('refuses the next model call of a run whose workspace crossed its cap, and ends the run with the reason', async () => {
    const { call, ended, upstream } = await harness({
      cap: 5,
      window: { costUsd: '5', unpricedUsage: false },
    });

    const response = await call();

    expect(response.status).toBe(403);
    const body = await problemOf(response);
    expect(body.code).toBe('daily_cost_cap_reached');
    expect(body.type).toBe('permission_error');
    expect(upstream).toEqual([]);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ workspaceId: SUBJECT.workspaceId, runId: SUBJECT.runId });
    const reason =
      'The workspace has reached its daily model cost cap; the run was stopped at this model call. capUsd: 5, resetsAt: 2026-10-28T00:00:00.000Z';
    expect(body.message).toBe(reason);
    expect(ended[0]?.error).toBe(`daily_cost_cap_reached: ${reason}`);
    expect(parseRunFailure(ended[0]?.error ?? null)?.code).toBe('daily_cost_cap_reached');
  });

  it('is installed by the gateway application, over a run token carrying the cap', async () => {
    const { ledger, ended } = fakeLedger({ costUsd: '7.5', unpricedUsage: false });
    const application = createGatewayApplication({
      resolver: resolverOver(ended),
      tokenSecret: SECRET,
      dailyCost: createDailyCostAdmission(ledger, { now: () => NOON }),
    });
    const token = await createRunTokenCodec({ secret: SECRET }).issue({
      ...SUBJECT,
      dailyCostCapUsd: 7.5,
    });

    const response = await application.fetch(
      new Request('http://gateway:4000/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-fixture', messages: [] }),
      }),
    );

    expect(response.status).toBe(403);
    expect((await problemOf(response)).code).toBe('daily_cost_cap_reached');
    expect(ended).toHaveLength(1);
  });

  it('lets a call under the cap through, unchanged', async () => {
    const { call, ended, upstream } = await harness({
      cap: 5,
      window: { costUsd: '4.999999', unpricedUsage: false },
    });

    expect((await call()).status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(ended).toEqual([]);
  });

  it('does not show the spend: not in the response, not in the run’s reason', async () => {
    const { call, ended } = await harness({
      cap: 5,
      window: { costUsd: '7.123456', unpricedUsage: false },
    });

    const response = await call();
    const body = await response.text();

    for (const shown of [body, ended[0]?.error ?? '']) {
      expect(shown).not.toMatch(/7\.1234|spent/iu);
      expect(shown).toContain('capUsd: 5');
    }
  });

  it('refuses a call under the cap when some of the day is unpriced, as the run start does', async () => {
    const { call, ended } = await harness({
      cap: 5,
      window: { costUsd: '1', unpricedUsage: true },
    });

    const response = await call();

    expect(response.status).toBe(403);
    const body = await problemOf(response);
    expect(body.code).toBe('daily_cost_cap_reached');
    const reason =
      'Some of the workspace model spend today has no price, so its daily cost cap cannot be measured; the run was stopped at this model call. capUsd: 5, resetsAt: 2026-10-28T00:00:00.000Z, unpricedUsage: true';
    expect(body.message).toBe(reason);
    expect(ended[0]?.error).toBe(`daily_cost_cap_reached: ${reason}`);
  });

  it('never refuses, and never reads the spend, for a workspace with no cap', async () => {
    const { call, reads, ended, upstream } = await harness({
      window: { costUsd: '1000000', unpricedUsage: true },
    });

    expect((await call()).status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(reads).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('fails closed with daily_cost_unavailable when the spend cannot be read, without ending the run', async () => {
    const { call, ended, upstream, state, reads } = await harness({
      cap: 5,
      window: new Error('connection refused to db.internal:5432'),
    });

    const response = await call();

    expect(response.status).toBe(503);
    const body = await problemOf(response);
    expect(body.code).toBe('daily_cost_unavailable');
    expect(body.type).toBe('api_error');
    expect(JSON.stringify(body)).not.toContain('db.internal');
    expect(upstream).toEqual([]);
    expect(ended).toEqual([]);

    // A failed read is not cached: the next call reads again and recovers.
    state.window = { costUsd: '1', unpricedUsage: false };
    expect((await call()).status).toBe(200);
    expect(reads).toHaveLength(2);
  });

  it('tells onError of a failed read and a failed run end, and both answer 503 carrying neither', async () => {
    const readError = new Error('connection refused to db.internal:5432');
    const endError = new Error('permission denied for table runs');
    const fake = fakeLedger(readError);
    const ledger: DailyCostLedger = { ...fake.ledger, endRun: () => Promise.reject(endError) };
    const errors: { error: unknown; context: DailyCostErrorContext }[] = [];
    const admission = createDailyCostAdmission(ledger, {
      now: () => NOON,
      onError: (error, context) => errors.push({ error, context }),
    });
    const claims = {
      ...SUBJECT,
      version: 1 as const,
      tokenId: 'token',
      issuedAt: 1,
      expiresAt: 2,
      dailyCostCapUsd: 5,
    };

    const unavailable = await admission.admit(claims);
    fake.state.window = { costUsd: '9', unpricedUsage: false };
    const reached = await admission.admit(claims);

    expect(errors).toEqual([
      {
        error: readError,
        context: { stage: 'read', workspaceId: SUBJECT.workspaceId, runId: SUBJECT.runId },
      },
      {
        error: endError,
        context: { stage: 'end-run', workspaceId: SUBJECT.workspaceId, runId: SUBJECT.runId },
      },
    ]);
    expect(unavailable).toMatchObject({ status: 503, code: 'daily_cost_unavailable' });
    // 403 reads as a rejected key to an engine: it is answered only once the run's end is written.
    expect(reached).toMatchObject({ status: 503, code: 'daily_cost_unavailable' });
    expect(JSON.stringify([unavailable, reached])).not.toMatch(/db\.internal|permission denied/);
  });

  it('does not gate calls that are not model turns', async () => {
    const { call, reads, upstream } = await harness({
      cap: 5,
      window: { costUsd: '50', unpricedUsage: false },
      path: '/v1/models',
    });

    expect((await call()).status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  it('answers token_revoked to the next call of a run the cap ended, without reading the spend again', async () => {
    const { call, reads, ended } = await harness({
      cap: 5,
      window: { costUsd: '9', unpricedUsage: false },
    });

    expect((await call()).status).toBe(403);
    expect(ended).toHaveLength(1);
    const again = await call();

    expect(again.status).toBe(401);
    expect((await problemOf(again)).code).toBe('token_revoked');
    expect(reads).toHaveLength(1);
  });
});
