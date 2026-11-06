import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  WEBHOOK_SIGNATURE_HEADERS,
  webhookSignedContent,
} from '@indx-workspace/contracts/webhooks';
import { createClient } from '@indx-workspace/sdk';
import { fixtures, jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineRecipe, resourceEvent, schedule } from '../recipe.js';
import {
  RecipeRunDetailSchema,
  RecipeRunPageSchema,
  RecipeSlotResponseSchema,
} from '../recipe-wire.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import {
  awaitingApproval,
  completed,
  scriptedPlatform,
} from '../testing/recipe-harness-platform.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { consoleRunUrl, recipeRoutes, type RecipeRoutes } from './recipe-routes.js';
import { recipeRunner, type RecipeRunner } from './recipe-runner.js';
import { serveRecipes } from './recipe-runner-runtime.js';
import { testClock } from '../testing/test-clock.js';

const TRIAGE_AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const BASE = 'https://app.test/api/recipes';

const triageIncident = defineRecipe({
  name: 'triage-incident',
  on: resourceEvent('ticket', 'created'),
  async run({ aw, step }) {
    await step('classify', async () => {
      const { result } = await aw.runs.start(TRIAGE_AGENT, { prompt: 'classify' });
      return (await result).text;
    });
    await step('notify', () => Promise.resolve('notified'));
  },
});

const sweep = defineRecipe({
  name: 'sla-sweep',
  on: schedule('*/5 * * * *'),
  async run({ step }) {
    await step('sweep', () => Promise.resolve('swept'));
  },
});

const app = { recipes: [triageIncident, sweep] };

/** The tokens the platform knows: a member, and one the platform refuses every decision to. */
const MEMBER = 'awo_live_recipesmember';
const REFUSED = 'awo_live_recipesrefused';
const STRANGER = 'awo_live_recipesstranger';
/** An Admin of the workspace, who may fire a schedule slot (ADR-0164 T3). */
const ADMIN = 'awo_live_recipesadmin';

let runtime: TestAppRuntime;
let runner: RecipeRunner;
let routes: RecipeRoutes;
let platform: ReturnType<typeof scriptedPlatform>;
let secret: string;

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The Standard Webhooks headers of `body`, delivery `id`, signed at `at` with `key`. */
async function signed(body: string, at: Date, id: string, key = secret): Promise<Headers> {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const raw = Uint8Array.from(atob(key.slice('whsec_'.length)), (char) => char.charCodeAt(0));
  const hmac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmac,
    new TextEncoder().encode(webhookSignedContent(id, timestamp, body)),
  );
  return new Headers({
    'content-type': 'application/json',
    [WEBHOOK_SIGNATURE_HEADERS.id]: id,
    [WEBHOOK_SIGNATURE_HEADERS.timestamp]: timestamp,
    [WEBHOOK_SIGNATURE_HEADERS.signature]: `v1,${base64(new Uint8Array(signature))}`,
  });
}

function me(token: string): Response {
  const workspaceId = token === STRANGER ? OTHER_WORKSPACE_ID : FAKE_WORKSPACE_ID;
  return jsonResponse(200, {
    principalId: '00000000-0000-4000-8000-0000000000aa',
    kind: 'membership',
    role: token === ADMIN ? 'admin' : 'builder',
    workspaceId,
    userId: crypto.randomUUID(),
    label: 'Someone',
    features: [],
  });
}

/**
 * The platform the routes call as the person: `/api/me`, then the scripted runs; the `REFUSED`
 * person's decisions are refused `403`, and `approvalAnswer` overrides every decision when set.
 */
let approvalAnswer: Response | undefined;
const asPerson: typeof fetch = async (input, init) => {
  const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /u, '') ?? '';
  if (![MEMBER, REFUSED, STRANGER, ADMIN].includes(token)) {
    return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
  }
  const path = new URL(href).pathname;
  if (path === '/api/me') return me(token);
  if (path.endsWith('/approval')) {
    if (token === REFUSED) {
      return jsonResponse(403, { error: { code: 'forbidden', message: 'You may not decide.' } });
    }
    if (approvalAnswer !== undefined) return approvalAnswer;
  }
  return platform.double.fetch(input, init);
};

function get(path: string, token: string | null = MEMBER): Request {
  return new Request(`${BASE}${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function post(path: string, body: unknown, token: string | null = MEMBER): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function problemOf(response: Response): Promise<{ status: number; code: string }> {
  const body = ApiProblemSchema.parse(await response.json());
  return { status: response.status, code: body.error.code };
}

/** A recipe run started and executed until its first step waits for approval. */
async function waitingRun(): Promise<string> {
  const run = await runner.start(triageIncident, {}, { person: null });
  expect(run.status).toBe('waiting');
  return run.id;
}

beforeEach(() => {
  approvalAnswer = undefined;
  secret = `whsec_${base64(crypto.getRandomValues(new Uint8Array(32)))}`;
  platform = scriptedPlatform(FAKE_WORKSPACE_ID, {
    [TRIAGE_AGENT]: [awaitingApproval(), completed('triaged')],
  });
  runtime = setAppRuntimeForTests({ fetch: asPerson, recipeWebhookSecret: secret });
  runner = recipeRunner(app, {
    client: createClient({
      baseUrl: 'https://aw.test',
      auth: { kind: 'api-key', apiKey: 'app' },
      fetch: platform.double.fetch,
    }),
    store: runtime.recipeStore,
    workspaceId: FAKE_WORKSPACE_ID,
    log: () => undefined,
  });
  routes = recipeRoutes(app, { runner });
});

afterEach(async () => {
  await runner.stop();
  resetAppRuntimeForTests();
});

describe('recipeRoutes list (#1514)', () => {
  it('pages the runs newest first and filters them by recipe and status', async () => {
    for (let index = 0; index < 3; index += 1) await runner.start(sweep, {}, { person: null });
    const waiting = await waitingRun();

    const first = RecipeRunPageSchema.parse(
      await (await routes.list.GET(get('/runs?limit=2'))).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = RecipeRunPageSchema.parse(
      await (
        await routes.list.GET(
          get(`/runs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`),
        )
      ).json(),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((run) => run.id)).size).toBe(4);

    const sweeps = RecipeRunPageSchema.parse(
      await (await routes.list.GET(get('/runs?recipe=sla-sweep'))).json(),
    );
    expect(sweeps.items.map((run) => run.recipe)).toEqual(['sla-sweep', 'sla-sweep', 'sla-sweep']);
    const paused = RecipeRunPageSchema.parse(
      await (await routes.list.GET(get('/runs?status=waiting'))).json(),
    );
    expect(paused.items.map((run) => run.id)).toEqual([waiting]);
    expect(Object.keys(paused.items[0] ?? {})).not.toContain('input');
  });

  it('refuses an unknown query key, a repeated one and a bad status as invalid_query', async () => {
    for (const query of ['?owner=me', '?status=waiting&status=failed', '?status=asleep']) {
      expect(await problemOf(await routes.list.GET(get(`/runs${query}`)))).toEqual({
        status: 400,
        code: 'invalid_query',
      });
    }
    expect(await problemOf(await routes.list.GET(get('/runs?cursor=nope')))).toEqual({
      status: 400,
      code: 'invalid_cursor',
    });
  });

  it('answers 401 without a person, and a member of another workspace is no person', async () => {
    expect(await problemOf(await routes.list.GET(get('/runs', null)))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
    expect(await problemOf(await routes.list.GET(get('/runs', STRANGER)))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });
});

describe('recipeRoutes item (#1514)', () => {
  it('answers the run with its steps, the pending call and the console run link', async () => {
    const id = await waitingRun();
    const response = await routes.item.GET(get(`/runs/${id}`), params({ id }));
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
    const { run } = await runtime.recipeStore.insertOrGetRun({
      workspaceId: OTHER_WORKSPACE_ID,
      recipe: 'triage-incident',
      input: {},
      dedupeKey: 'theirs',
      startedBy: null,
      at: new Date(),
    });
    for (const id of [run.id, 'not-a-uuid', crypto.randomUUID()]) {
      expect(await problemOf(await routes.item.GET(get(`/runs/${id}`), params({ id })))).toEqual({
        status: 404,
        code: 'recipe_run_not_found',
      });
    }
  });
});

describe('recipeRoutes decision (#1514)', () => {
  const decision = (id: string, key: string, body: unknown, token: string | null = MEMBER) =>
    routes.decision.POST(
      post(`/runs/${id}/steps/${key}/decision`, body, token),
      params({ id, key }),
    );

  it("approves with the person's own client, and the recipe completes on the continuation", async () => {
    const decide = vi.spyOn(runner, 'decide');
    const id = await waitingRun();
    const response = await decision(id, 'classify', { decision: 'approve', comment: 'ok' });
    expect(response.status).toBe(200);
    RecipeRunDetailSchema.parse(await response.json());
    expect(decide).toHaveBeenCalledWith(
      { recipeRunId: id, stepKey: 'classify', decision: 'approve', comment: 'ok' },
      expect.anything(),
    );
    const approval = platform.double.calls.find((call) => call.url.pathname.endsWith('/approval'));
    expect(approval?.headers.get('authorization')).toBe(`Bearer ${MEMBER}`);
    await runner.drain();
    expect((await runtime.recipeStore.getRun(FAKE_WORKSPACE_ID, id))?.status).toBe('completed');
  });

  it('rejects through the runner too', async () => {
    const id = await waitingRun();
    expect((await decision(id, 'classify', { decision: 'reject' })).status).toBe(200);
    const rejection = platform.double.calls.find((call) => call.url.pathname.endsWith('/approval'));
    expect(rejection?.json).toEqual({ decision: 'reject' });
  });

  it('answers 409 recipe_step_not_awaiting_approval for a step that does not wait', async () => {
    const id = await waitingRun();
    for (const key of ['notify', 'Not A Key']) {
      expect(await problemOf(await decision(id, key, { decision: 'approve' }))).toEqual({
        status: 409,
        code: 'recipe_step_not_awaiting_approval',
      });
    }
  });

  it('passes approval_already_decided on by its code', async () => {
    const id = await waitingRun();
    const step = await runtime.recipeStore.getStep(id, 'classify');
    platform.decideOutside(step?.runId ?? '');
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }))).toEqual({
      status: 409,
      code: 'approval_already_decided',
    });
  });

  it('passes approval_expired on by its code, and the step fails with it', async () => {
    const id = await waitingRun();
    const paused = await runtime.recipeStore.getStep(id, 'classify');
    platform.expire(paused?.runId ?? '');
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }))).toEqual({
      status: 409,
      code: 'approval_expired',
    });
    expect((await runtime.recipeStore.getStep(id, 'classify'))?.error).toBe('approval_expired');
  });

  it('passes on run_not_awaiting_approval from the platform by its code', async () => {
    const id = await waitingRun();
    approvalAnswer = jsonResponse(409, {
      error: { code: 'run_not_awaiting_approval', message: 'no' },
    });
    expect(await problemOf(await decision(id, 'classify', { decision: 'approve' }))).toEqual({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
  });

  it("a decision as a person the platform refuses returns the platform's code", async () => {
    const id = await waitingRun();
    expect(
      await problemOf(await decision(id, 'classify', { decision: 'approve' }, REFUSED)),
    ).toEqual({ status: 403, code: 'forbidden' });
    expect((await runtime.recipeStore.getStep(id, 'classify'))?.status).toBe('awaiting_approval');
  });

  it('answers 400 invalid_body for an unknown body key, 404 for another run, 401 without a person', async () => {
    const id = await waitingRun();
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
    const id = await waitingRun();
    for (const unserved of [recipeRoutes(app), recipeRoutes(app, { runner: () => undefined })]) {
      const response = await unserved.decision.POST(
        post(`/runs/${id}/steps/classify/decision`, { decision: 'approve' }),
        params({ id, key: 'classify' }),
      );
      expect(await problemOf(response)).toEqual({ status: 503, code: 'recipes_unavailable' });
    }
  });

  it('finds its runner when a request comes, through a function', async () => {
    const id = await waitingRun();
    const found = recipeRoutes(app, { runner: () => runner });
    const response = await found.decision.POST(
      post(`/runs/${id}/steps/classify/decision`, { decision: 'approve' }),
      params({ id, key: 'classify' }),
    );
    expect(response.status).toBe(200);
  });
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
    routes.webhook.POST(new Request(`${BASE}/webhook`, { method: 'POST', headers, body }));

  it('wakes the steps waiting on the run of a verified delivery', async () => {
    const onRunOutcome = vi.spyOn(runner, 'onRunOutcome');
    const now = new Date();
    const id = await waitingRun();
    const runId = (await runtime.recipeStore.getStep(id, 'classify'))?.runId ?? '';
    const delivery = crypto.randomUUID();
    const raw = webhookOf(delivery, runId, now);
    const response = await deliver(raw, await signed(raw, now, delivery));
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(onRunOutcome).toHaveBeenCalledTimes(1);
    });
    expect(onRunOutcome.mock.calls[0]?.[0].data.run.id).toBe(runId);
  });

  it('refuses an unsigned, a forged and a stale delivery with 401', async () => {
    const onRunOutcome = vi.spyOn(runner, 'onRunOutcome');
    const now = new Date();
    const id = crypto.randomUUID();
    const raw = webhookOf(id, crypto.randomUUID(), now);
    const unsigned = new Headers({ 'content-type': 'application/json' });
    const forged = await signed(raw, now, id, `whsec_${base64(new Uint8Array(32))}`);
    const stale = await signed(raw, new Date(now.getTime() - 3_600_000), id);
    for (const headers of [unsigned, forged, stale]) {
      expect(await problemOf(await deliver(raw, headers))).toEqual({
        status: 401,
        code: 'webhook_unverified',
      });
    }
    expect(onRunOutcome).not.toHaveBeenCalled();
  });

  it('answers 503 when the app has no webhook secret', async () => {
    setAppRuntimeForTests({ fetch: asPerson });
    const raw = webhookOf(crypto.randomUUID(), crypto.randomUUID(), new Date());
    expect(await problemOf(await deliver(raw, new Headers()))).toEqual({
      status: 503,
      code: 'recipes_unavailable',
    });
  });
});

describe('recipeRoutes slots (ADR-0164 T3, #2077)', () => {
  const at = '2026-02-03T04:05:00.000Z';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts the slot with input.slot = at as an Admin, once however often it is fired', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await routes.slots.POST(post('/slots', { recipe: 'sla-sweep', at }, ADMIN));
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { run } = RecipeSlotResponseSchema.parse(await response.json());
    expect(run).toMatchObject({ recipe: 'sla-sweep', startedBy: null });
    await runner.drain();

    const again = await routes.slots.POST(
      post('/slots', { recipe: 'sla-sweep', at: '2026-02-03T13:05:00+09:00' }, ADMIN),
    );
    expect(RecipeSlotResponseSchema.parse(await again.json()).run.id).toBe(run.id);
    const stored = await runtime.recipeStore.getRun(FAKE_WORKSPACE_ID, run.id);
    expect(stored).toMatchObject({
      status: 'completed',
      input: { slot: at },
      dedupeKey: `schedule:sla-sweep:${at}`,
    });
  });

  it('answers 401 with no person and 403 for a member who is not an Owner or Admin', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(
      await problemOf(await routes.slots.POST(post('/slots', { recipe: 'sla-sweep', at }, null))),
    ).toEqual({ status: 401, code: 'unauthenticated' });
    expect(
      await problemOf(await routes.slots.POST(post('/slots', { recipe: 'sla-sweep', at }))),
    ).toEqual({ status: 403, code: 'forbidden' });
  });

  it('answers 400 for a body that is not strict and for a recipe that is not a schedule', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const body of [
      { recipe: 'sla-sweep', at, extra: true },
      { recipe: 'sla-sweep', at: 'yesterday' },
      { recipe: 'sla-sweep', at: '2026-02-03T04:05:00' },
      { recipe: 'Bad Name', at },
    ]) {
      expect(await problemOf(await routes.slots.POST(post('/slots', body, ADMIN)))).toEqual({
        status: 400,
        code: 'invalid_body',
      });
    }
    expect(
      await problemOf(
        await routes.slots.POST(post('/slots', { recipe: 'triage-incident', at }, ADMIN)),
      ),
    ).toEqual({ status: 400, code: 'recipe_not_schedule' });
    expect(
      await problemOf(await routes.slots.POST(post('/slots', { recipe: 'no-such', at }, ADMIN))),
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
    const response = await routes.slots.POST(post('/slots', { recipe: 'sla-sweep', at }, ADMIN));
    expect(await problemOf(response)).toEqual({ status: 404, code: 'not_found' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await runtime.recipeStore.listRuns(FAKE_WORKSPACE_ID, {})).items).toEqual([]);

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
