import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecipeSlotResponseSchema } from '../recipe-wire.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import { testClock } from '../testing/test-clock.js';
import { recipeRoutes } from './recipe-routes.js';
import { serveRecipes } from './recipe-runner-runtime.js';
import {
  ADMIN,
  app,
  endRecipeRoutesWorld,
  post,
  problemOf,
  startRecipeRoutesWorld,
  type RecipeRoutesWorld,
} from './recipe-routes.test-support.js';

let world: RecipeRoutesWorld;

beforeEach(() => {
  world = startRecipeRoutesWorld();
});

afterEach(async () => {
  await endRecipeRoutesWorld(world);
});

const at = '2026-02-03T04:05:00.000Z';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('recipeRoutes slots (ADR-0164 T3, #2077)', () => {
  it('starts the slot with input.slot = at as an Admin, once however often it is fired', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await world.routes.slots.POST(
      post('/slots', { recipe: 'sla-sweep', at }, ADMIN),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { run } = RecipeSlotResponseSchema.parse(await response.json());
    expect(run).toMatchObject({ recipe: 'sla-sweep', startedBy: null });
    await world.runner.drain();

    const again = await world.routes.slots.POST(
      post('/slots', { recipe: 'sla-sweep', at: '2026-02-03T13:05:00+09:00' }, ADMIN),
    );
    expect(RecipeSlotResponseSchema.parse(await again.json()).run.id).toBe(run.id);
    const stored = await world.runtime.recipeStore.getRun(FAKE_WORKSPACE_ID, run.id);
    expect(stored).toMatchObject({
      status: 'completed',
      input: { slot: at },
      dedupeKey: `schedule:sla-sweep:${at}`,
    });
  });

  it('answers 401 with no person and 403 for a member who is not an Owner or Admin', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(
      await problemOf(
        await world.routes.slots.POST(post('/slots', { recipe: 'sla-sweep', at }, null)),
      ),
    ).toEqual({ status: 401, code: 'unauthenticated' });
    expect(
      await problemOf(await world.routes.slots.POST(post('/slots', { recipe: 'sla-sweep', at }))),
    ).toEqual({ status: 403, code: 'forbidden' });
  });
});

describe('recipeRoutes slots refusals (ADR-0164 T3, #2077)', () => {
  it('answers 400 for a body that is not strict and for a recipe that is not a schedule', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const body of [
      { recipe: 'sla-sweep', at, extra: true },
      { recipe: 'sla-sweep', at: 'yesterday' },
      { recipe: 'sla-sweep', at: '2026-02-03T04:05:00' },
      { recipe: 'Bad Name', at },
    ]) {
      expect(await problemOf(await world.routes.slots.POST(post('/slots', body, ADMIN)))).toEqual({
        status: 400,
        code: 'invalid_body',
      });
    }
    expect(
      await problemOf(
        await world.routes.slots.POST(post('/slots', { recipe: 'triage-incident', at }, ADMIN)),
      ),
    ).toEqual({ status: 400, code: 'recipe_not_schedule' });
    expect(
      await problemOf(
        await world.routes.slots.POST(post('/slots', { recipe: 'no-such', at }, ADMIN)),
      ),
    ).toEqual({ status: 400, code: 'recipe_not_found' });
  });

  it('answers 503 recipes_unavailable when no runner serves this process', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const unserved = recipeRoutes(app, { runner: () => undefined });
    expect(
      await problemOf(
        await unserved.slots.POST(post('/slots', { recipe: 'sla-sweep', at }, ADMIN)),
      ),
    ).toEqual({ status: 503, code: 'recipes_unavailable' });
  });

  it('a production app has no clock override or trigger', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await world.routes.slots.POST(
      post('/slots', { recipe: 'sla-sweep', at }, ADMIN),
    );
    expect(await problemOf(response)).toEqual({ status: 404, code: 'not_found' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await world.runtime.recipeStore.listRuns(FAKE_WORKSPACE_ID, {})).items).toEqual([]);

    await expect(serveRecipes(app, {}, { clock: testClock() })).rejects.toMatchObject({
      name: 'RecipeError',
      code: 'clock_override_refused',
    });
    vi.stubEnv('NODE_ENV', 'test');
    await expect(
      serveRecipes(app, { NODE_ENV: 'production' }, { clock: testClock() }),
    ).rejects.toMatchObject({ code: 'clock_override_refused' });
  });
});
