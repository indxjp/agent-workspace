import { fixtures } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import { setAppRuntimeForTests } from '../testing/runtime.js';
import {
  base64,
  endRecipeRoutesWorld,
  problemOf,
  signed,
  startRecipeRoutesWorld,
  waitingRun,
  webhookRequest,
  type RecipeRoutesWorld,
} from './recipe-routes.test-support.js';

let world: RecipeRoutesWorld;

beforeEach(() => {
  world = startRecipeRoutesWorld();
});

afterEach(async () => {
  await endRecipeRoutesWorld(world);
});

describe('recipeRoutes webhook (#1514)', () => {
  const webhookOf = (id: string, runId: string, at: Date): string => {
    const run = fixtures.run({ id: runId, workspaceId: FAKE_WORKSPACE_ID, status: 'completed' });
    const { agentId, sessionId, status, endedAt, error, usage, cost, accountingState } = run;
    return JSON.stringify({
      id,
      type: 'run.completed',
      createdAt: at.toISOString(),
      workspaceId: FAKE_WORKSPACE_ID,
      data: {
        run: {
          id: runId,
          agentId,
          sessionId,
          status,
          endedAt,
          error,
          usage,
          cost,
          accountingState,
        },
      },
    });
  };

  const deliver = async (body: string, headers: Headers): Promise<Response> =>
    world.routes.webhook.POST(webhookRequest(headers, body));

  it('wakes the steps waiting on the run of a verified delivery', async () => {
    const onRunOutcome = vi.spyOn(world.runner, 'onRunOutcome');
    const now = new Date();
    const id = await waitingRun(world);
    const runId = (await world.runtime.recipeStore.getStep(id, 'classify'))?.runId ?? '';
    const delivery = crypto.randomUUID();
    const raw = webhookOf(delivery, runId, now);
    const response = await deliver(raw, await signed(world.secret, raw, now, delivery));
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(onRunOutcome).toHaveBeenCalledTimes(1);
    });
    expect(onRunOutcome.mock.calls[0]?.[0].data.run.id).toBe(runId);
  });

  it('refuses an unsigned, a forged and a stale delivery with 401', async () => {
    const onRunOutcome = vi.spyOn(world.runner, 'onRunOutcome');
    const now = new Date();
    const id = crypto.randomUUID();
    const raw = webhookOf(id, crypto.randomUUID(), now);
    const unsigned = new Headers({ 'content-type': 'application/json' });
    const forged = await signed(`whsec_${base64(new Uint8Array(32))}`, raw, now, id);
    const stale = await signed(world.secret, raw, new Date(now.getTime() - 3_600_000), id);
    for (const headers of [unsigned, forged, stale]) {
      expect(await problemOf(await deliver(raw, headers))).toEqual({
        status: 401,
        code: 'webhook_unverified',
      });
    }
    expect(onRunOutcome).not.toHaveBeenCalled();
  });

  it('answers 503 when the app has no webhook secret', async () => {
    setAppRuntimeForTests({ fetch: world.asPerson });
    const raw = webhookOf(crypto.randomUUID(), crypto.randomUUID(), new Date());
    expect(await problemOf(await deliver(raw, new Headers()))).toEqual({
      status: 503,
      code: 'recipes_unavailable',
    });
  });
});
