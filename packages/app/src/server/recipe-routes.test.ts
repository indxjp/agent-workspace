import { RecipeRunDetailSchema, RecipeRunPageSchema } from '../recipe-wire.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consoleRunUrl } from './recipe-routes.js';
import {
  endRecipeRoutesWorld,
  get,
  OTHER_WORKSPACE_ID,
  params,
  problemOf,
  startRecipeRoutesWorld,
  STRANGER,
  sweep,
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

describe('recipeRoutes list (#1514)', () => {
  it('pages the runs newest first and filters them by recipe and status', async () => {
    for (let index = 0; index < 3; index += 1)
      await world.runner.start(sweep, {}, { person: null });
    const waiting = await waitingRun(world);

    const first = RecipeRunPageSchema.parse(
      await (await world.routes.list.GET(get('/runs?limit=2'))).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = RecipeRunPageSchema.parse(
      await (
        await world.routes.list.GET(
          get(`/runs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`),
        )
      ).json(),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((run) => run.id)).size).toBe(4);

    const sweeps = RecipeRunPageSchema.parse(
      await (await world.routes.list.GET(get('/runs?recipe=sla-sweep'))).json(),
    );
    expect(sweeps.items.map((run) => run.recipe)).toEqual(['sla-sweep', 'sla-sweep', 'sla-sweep']);
    const paused = RecipeRunPageSchema.parse(
      await (await world.routes.list.GET(get('/runs?status=waiting'))).json(),
    );
    expect(paused.items.map((run) => run.id)).toEqual([waiting]);
    expect(Object.keys(paused.items[0] ?? {})).not.toContain('input');
  });

  it('refuses an unknown query key, a repeated one and a bad status as invalid_query', async () => {
    for (const query of ['?owner=me', '?status=waiting&status=failed', '?status=asleep']) {
      expect(await problemOf(await world.routes.list.GET(get(`/runs${query}`)))).toEqual({
        status: 400,
        code: 'invalid_query',
      });
    }
    expect(await problemOf(await world.routes.list.GET(get('/runs?cursor=nope')))).toEqual({
      status: 400,
      code: 'invalid_cursor',
    });
  });

  it('answers 401 without a person, and a member of another workspace is no person', async () => {
    expect(await problemOf(await world.routes.list.GET(get('/runs', null)))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
    expect(await problemOf(await world.routes.list.GET(get('/runs', STRANGER)))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });
});

describe('recipeRoutes item (#1514)', () => {
  it('answers the run with its steps, the pending call and the console run link', async () => {
    const id = await waitingRun(world);
    const response = await world.routes.item.GET(get(`/runs/${id}`), params({ id }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const detail = RecipeRunDetailSchema.parse(await response.json());
    expect(detail.run).toMatchObject({ id, recipe: 'triage-incident', status: 'waiting' });
    const [classify] = detail.steps;
    expect(detail.steps).toHaveLength(1);
    expect(classify).toMatchObject({
      key: 'classify',
      status: 'awaiting_approval',
      pendingApproval: { toolName: 'send_email' },
      cost: { currency: 'USD' },
    });
    expect(classify?.runUrl).toBe(consoleRunUrl('https://aw.test', classify?.runId ?? ''));
  });

  it("answers 404 recipe_run_not_found for another workspace's run and a non-UUID", async () => {
    const { run } = await world.runtime.recipeStore.insertOrGetRun({
      workspaceId: OTHER_WORKSPACE_ID,
      recipe: 'triage-incident',
      input: {},
      dedupeKey: 'theirs',
      startedBy: null,
      at: new Date(),
    });
    for (const id of [run.id, 'not-a-uuid', crypto.randomUUID()]) {
      expect(
        await problemOf(await world.routes.item.GET(get(`/runs/${id}`), params({ id }))),
      ).toEqual({
        status: 404,
        code: 'recipe_run_not_found',
      });
    }
  });
});
