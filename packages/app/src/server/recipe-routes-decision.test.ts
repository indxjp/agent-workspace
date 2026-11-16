import { TransportError } from '@indx-workspace/sdk';
import { jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecipeRunDetailSchema } from '../recipe-wire.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import { recipeRoutes } from './recipe-routes.js';
import {
  app,
  endRecipeRoutesWorld,
  MEMBER,
  params,
  post,
  problemOf,
  REFUSED,
  startRecipeRoutesWorld,
  waitingRun,
  type RecipeRoutesWorld,
} from './recipe-routes.test-support.js';

let world: RecipeRoutesWorld;

beforeEach(() => {
  world = startRecipeRoutesWorld();
});

afterEach(async () => {
  await endRecipeRoutesWorld(world);
});

const decision = (id: string, key: string, body: unknown, token: string | null = MEMBER) =>
  world.routes.decision.POST(
    post(`/runs/${id}/steps/${key}/decision`, body, token),
    params({ id, key }),
  );

describe('recipeRoutes decision (#1514)', () => {
  it("approves with the person's own client, and the recipe completes on the continuation", async () => {
    const decide = vi.spyOn(world.runner, 'decide');
    const id = await waitingRun(world);
    const response = await decision(id, 'classify', { decision: 'approve', comment: 'ok' });
    expect(response.status).toBe(200);
    RecipeRunDetailSchema.parse(await response.json());
    expect(decide).toHaveBeenCalledWith(
      { recipeRunId: id, stepKey: 'classify', decision: 'approve', comment: 'ok' },
      expect.anything(),
    );
    const approval = world.platform.double.calls.find((call) =>
      call.url.pathname.endsWith('/approval'),
    );
    expect(approval?.headers.get('authorization')).toBe(`Bearer ${MEMBER}`);
    await world.runner.drain();
    expect((await world.runtime.recipeStore.getRun(FAKE_WORKSPACE_ID, id))?.status).toBe(
      'completed',
    );
  });

  it('logs an upstream failure it answers as 502, without its text in the answer', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(world.runner, 'decide').mockRejectedValue(
      new TransportError({
        operation: 'decide approval',
        aborted: false,
        cause: new Error('connect ECONNREFUSED 10.0.0.1'),
      }),
    );
    const id = await waitingRun(world);
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }))).toEqual({
      status: 502,
      code: 'upstream_failure',
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('TransportError'));
  });

  it('rejects through the runner too', async () => {
    const id = await waitingRun(world);
    expect((await decision(id, 'classify', { decision: 'reject' })).status).toBe(200);
    const rejection = world.platform.double.calls.find((call) =>
      call.url.pathname.endsWith('/approval'),
    );
    expect(rejection?.json).toEqual({ decision: 'reject' });
  });
});

describe('recipeRoutes decision refusals (#1514)', () => {
  it('answers 409 recipe_step_not_awaiting_approval for a step that does not wait', async () => {
    const id = await waitingRun(world);
    for (const key of ['notify', 'Not A Key']) {
      expect(await problemOf(await decision(id, key, { decision: 'approve' }))).toEqual({
        status: 409,
        code: 'recipe_step_not_awaiting_approval',
      });
    }
  });

  it('passes approval_already_decided on by its code', async () => {
    const id = await waitingRun(world);
    const step = await world.runtime.recipeStore.getStep(id, 'classify');
    world.platform.decideOutside(step?.runId ?? '');
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }))).toEqual({
      status: 409,
      code: 'approval_already_decided',
    });
  });

  it('passes approval_expired on by its code, and the step fails with it', async () => {
    const id = await waitingRun(world);
    const paused = await world.runtime.recipeStore.getStep(id, 'classify');
    world.platform.expire(paused?.runId ?? '');
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }))).toEqual({
      status: 409,
      code: 'approval_expired',
    });
    expect((await world.runtime.recipeStore.getStep(id, 'classify'))?.error).toBe(
      'approval_expired',
    );
  });

  it('passes on run_not_awaiting_approval from the platform by its code', async () => {
    const id = await waitingRun(world);
    world.answerApprovalsWith(
      jsonResponse(409, { error: { code: 'run_not_awaiting_approval', message: 'no' } }),
    );
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }))).toEqual({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
  });

  it("a decision as a person the platform refuses returns the platform's code", async () => {
    const id = await waitingRun(world);
    expect(
      await problemOf(await decision(id, 'classify', { decision: 'approve' }, REFUSED)),
    ).toEqual({ status: 403, code: 'forbidden' });
    expect((await world.runtime.recipeStore.getStep(id, 'classify'))?.status).toBe(
      'awaiting_approval',
    );
  });
});

describe('recipeRoutes decision requests (#1514)', () => {
  it('answers 400 invalid_body for an unknown body key, 404 for another run, 401 without a person', async () => {
    const id = await waitingRun(world);
    expect(
      await problemOf(await decision(id, 'classify', { decision: 'approve', why: 1 })),
    ).toEqual({ status: 400, code: 'invalid_body' });
    const missing = crypto.randomUUID();
    expect(await problemOf(await decision(missing, 'classify', { decision: 'approve' }))).toEqual({
      status: 404,
      code: 'recipe_run_not_found',
    });
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }, null))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it('answers 503 recipes_unavailable when no runner serves this process', async () => {
    const id = await waitingRun(world);
    for (const unserved of [recipeRoutes(app), recipeRoutes(app, { runner: () => undefined })]) {
      const response = await unserved.decision.POST(
        post(`/runs/${id}/steps/classify/decision`, { decision: 'approve' }),
        params({ id, key: 'classify' }),
      );
      expect(await problemOf(response)).toEqual({ status: 503, code: 'recipes_unavailable' });
    }
  });

  it('finds its runner when a request comes, through a function', async () => {
    const id = await waitingRun(world);
    const found = recipeRoutes(app, { runner: () => world.runner });
    const response = await found.decision.POST(
      post(`/runs/${id}/steps/classify/decision`, { decision: 'approve' }),
      params({ id, key: 'classify' }),
    );
    expect(response.status).toBe(200);
  });
});
