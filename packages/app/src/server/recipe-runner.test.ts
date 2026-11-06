import { createClient } from '@indx-workspace/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineRecipe, resourceEvent, schedule, type DefinedRecipe } from '../recipe.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import { memoryRecipeStore } from '../testing/memory-recipe-store.js';
import {
  awaitingApproval,
  completed,
  failed,
  PROVIDER_TEXT,
  recipeHarness,
} from '../testing/recipe-harness.js';
import { testClock } from '../testing/test-clock.js';
import { RecipeError } from './recipe-errors.js';
import { recipeRunner } from './recipe-runner.js';

const KEY = /^recipe:[0-9a-f-]{36}:[a-z0-9._-]+$/u;

/** The idempotency keys of the run starts the platform received, in order. */
function keysOf(requests: readonly { readonly headers: Headers }[]): string[] {
  return requests.map((request) => request.headers.get('idempotency-key') ?? '');
}

/** A recipe of two steps, each one run of its own agent. */
const twoSteps = defineRecipe({
  name: 'two-steps',
  on: resourceEvent('ticket', 'created'),
  async run({ aw, step }) {
    await step('triage', async () => {
      const { result } = await aw.runs.start('triage', { prompt: 'triage it' });
      return (await result).output as { severity: string };
    });
    await step('notify', async () => {
      await aw.runs.start('notifier', { prompt: 'tell the team' });
      return undefined;
    });
  },
});

/** The architecture doc's triage-incident example: triage, an approved escalation, a summary. */
const triageIncident = defineRecipe({
  name: 'triage-incident',
  on: resourceEvent('incident', 'created'),
  input: z.object({ title: z.string() }),
  async run({ aw, input, step }) {
    const triage = await step('triage', async () => {
      const { result } = await aw.runs.start('triage', {
        prompt: `Triage: ${input.title}`,
        outputSchema: z.object({ severity: z.enum(['low', 'high']) }),
      });
      return (await result).output ?? { severity: 'low' };
    });
    if (triage.severity !== 'high') return;
    await step('escalate', async () => {
      const { result } = await aw.runs.start('responder', { prompt: 'page the on-call' });
      return (await result).text;
    });
  },
});

describe('recipeRunner, through the harness', () => {
  it('a crash between steps resumes without a duplicate run', async () => {
    const harness = recipeHarness(twoSteps, {
      agents: { triage: [completed({ severity: 'high' })], notifier: [completed('done')] },
    });
    harness.crashAfter('triage');
    await harness.start();
    expect(harness.state().runs[0]?.status).toBe('running');

    await harness.restart();

    const [run] = harness.state().runs;
    expect(run?.status).toBe('completed');
    const keys = keysOf(harness.runsStarted());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(KEY);
    expect(keys).toEqual([`recipe:${run?.id ?? ''}:triage`, `recipe:${run?.id ?? ''}:notify`]);
    expect(harness.state().steps.map((step) => [step.key, step.output])).toEqual([
      ['triage', { severity: 'high' }],
      ['notify', 'done'],
    ]);
  });

  it('a crash after the run started and before it was recorded reuses the run by idempotency key', async () => {
    const harness = recipeHarness(twoSteps, {
      agents: { triage: [completed({ severity: 'low' })], notifier: [completed('done')] },
    });
    harness.crashAfter('triage', 'run-started');
    await harness.start();
    expect(harness.state().steps[0]?.runId).toBeNull();

    await harness.restart();

    expect(harness.state().runs[0]?.status).toBe('completed');
    const triageStarts = keysOf(harness.runsStarted()).filter((key) => key.endsWith(':triage'));
    expect(triageStarts).toHaveLength(2);
    expect(new Set(triageStarts).size).toBe(1);
    expect(harness.platformRuns().filter((run) => run.agentId === 'triage')).toHaveLength(1);
    expect(harness.state().steps[0]?.runId).toBe(harness.platformRuns()[0]?.id);
  });

  it('an approval stop resumes after a decision', async () => {
    const harness = recipeHarness(triageIncident, {
      agents: {
        triage: [completed({ severity: 'high' })],
        responder: [awaitingApproval(), completed('paged')],
      },
    });
    const waiting = await harness.start({ title: 'db down' });
    expect(waiting.status).toBe('waiting');
    expect(harness.state().steps.find((step) => step.key === 'escalate')?.status).toBe(
      'awaiting_approval',
    );

    const done = await harness.approve('escalate', 'go ahead');

    expect(done.status).toBe('completed');
    const escalate = harness.state().steps.find((step) => step.key === 'escalate');
    expect(escalate).toMatchObject({ status: 'completed', decision: 'approve', output: 'paged' });
    expect(escalate?.continuationRunId).not.toBeNull();
    expect(escalate?.continuationRunId).not.toBe(escalate?.runId);
  });

  it("a rejected approval completes the step with the continuation's outcome", async () => {
    const harness = recipeHarness(triageIncident, {
      agents: {
        triage: [completed({ severity: 'high' })],
        responder: [awaitingApproval(), completed('not paged: the call was refused')],
      },
    });
    await harness.start({ title: 'db down' });

    const done = await harness.reject('escalate');

    expect(done.status).toBe('completed');
    expect(harness.state().steps.find((step) => step.key === 'escalate')).toMatchObject({
      decision: 'reject',
      output: 'not paged: the call was refused',
    });
  });

  it('a reused step key is refused', async () => {
    const reused = defineRecipe({
      name: 'reused',
      on: schedule('0 * * * *'),
      async run({ step }) {
        await step('same', () => Promise.resolve(1));
        await step('same', () => Promise.resolve(2));
      },
    });
    const harness = recipeHarness(reused, { agents: {} });
    const run = await harness.start();
    expect(run).toMatchObject({ status: 'failed', error: 'step_key_reused' });
  });

  it('a second runs.start in one step throws step_starts_two_runs', async () => {
    const twice = defineRecipe({
      name: 'twice',
      on: schedule('0 * * * *'),
      async run({ aw, step }) {
        await step('both', async () => {
          await aw.runs.start('triage', { prompt: 'one' });
          await aw.runs.start('triage', { prompt: 'two' });
          return null;
        });
      },
    });
    const harness = recipeHarness(twice, { agents: { triage: [completed('a'), completed('b')] } });
    const run = await harness.start();
    expect(run).toMatchObject({ status: 'failed', error: 'step_starts_two_runs' });
    expect(harness.state().steps[0]).toMatchObject({
      status: 'failed',
      error: 'step_starts_two_runs',
    });
    expect(harness.runsStarted()).toHaveLength(1);
  });

  it('a run started outside a step is refused', async () => {
    const outside = defineRecipe({
      name: 'outside',
      on: schedule('0 * * * *'),
      async run({ aw }) {
        await aw.runs.start('triage', { prompt: 'no key' });
      },
    });
    const harness = recipeHarness(outside, { agents: { triage: [completed('a')] } });
    expect(await harness.start()).toMatchObject({
      status: 'failed',
      error: 'run_started_outside_step',
    });
    expect(harness.runsStarted()).toHaveLength(0);
  });

  it('two replicas firing one schedule slot start one recipe run', async () => {
    const hourly = defineRecipe({
      name: 'hourly',
      on: schedule('0 * * * *'),
      async run({ aw, step, input }) {
        await step('digest', async () => {
          await aw.runs.start('digest', { prompt: `digest ${(input as { slot: string }).slot}` });
          return undefined;
        });
      },
    });
    const harness = recipeHarness(hourly, {
      agents: { digest: [completed('one'), completed('two')] },
      startAt: new Date('2026-01-01T00:30:00.000Z'),
    });
    const other = harness.replica();
    harness.advance(31 * 60_000);

    await Promise.all([harness.runner().resume(), other.resume()]);

    expect(harness.state().runs).toHaveLength(1);
    expect(harness.state().runs[0]).toMatchObject({
      status: 'completed',
      dedupeKey: 'schedule:hourly:2026-01-01T01:00:00.000Z',
      input: { slot: '2026-01-01T01:00:00.000Z' },
      startedBy: null,
    });
    expect(harness.platformRuns()).toHaveLength(1);
  });

  it('a step whose input changed after a crash fails with recipe_step_input_changed', async () => {
    let prompt = 'first';
    const changing = defineRecipe({
      name: 'changing',
      on: schedule('0 * * * *'),
      async run({ aw, step }) {
        await step('ask', async () => {
          await aw.runs.start('triage', { prompt });
          return undefined;
        });
      },
    });
    const harness = recipeHarness(changing, {
      agents: { triage: [completed('a'), completed('b')] },
    });
    harness.crashAfter('ask', 'run-started');
    await harness.start();
    prompt = 'second';

    await harness.restart();

    expect(harness.state().runs[0]).toMatchObject({
      status: 'failed',
      error: 'recipe_step_input_changed',
    });
    expect(harness.platformRuns()).toHaveLength(1);
  });

  it('a two-agent recipe with an approval step completes across a restart', async () => {
    const harness = recipeHarness(triageIncident, {
      agents: {
        triage: [completed({ severity: 'high' })],
        responder: [awaitingApproval(), completed('paged')],
      },
    });
    harness.crashAfter('triage');
    await harness.start({ title: 'db down' });
    await harness.restart();
    expect(harness.state().runs[0]?.status).toBe('waiting');
    await harness.restart();
    expect(harness.state().runs[0]?.status).toBe('waiting');

    const done = await harness.approve('escalate');

    expect(done.status).toBe('completed');
    const keys = keysOf(harness.runsStarted());
    expect(keys.filter((key) => key.endsWith(':triage'))).toHaveLength(1);
    expect(harness.platformRuns().map((run) => run.agentId)).toEqual([
      'triage',
      'responder',
      'responder',
    ]);
    for (const key of keys) expect(key).toMatch(KEY);
  });

  it('a failed step stores the public failure code, never provider text', async () => {
    const harness = recipeHarness(twoSteps, {
      agents: { triage: [failed('model_unavailable')], notifier: [] },
    });
    const run = await harness.start();
    expect(run).toMatchObject({ status: 'failed', error: 'model_unavailable' });
    expect(harness.state().steps[0]).toMatchObject({
      status: 'failed',
      error: 'model_unavailable',
    });
    expect(JSON.stringify(harness.state())).not.toContain(PROVIDER_TEXT);
    expect(harness.runsStarted()).toHaveLength(1);
  });

  it('a step whose function throws stores step_failed, never the message', async () => {
    const throwing = defineRecipe({
      name: 'throwing',
      on: schedule('0 * * * *'),
      async run({ step }) {
        await step('boom', () =>
          Promise.reject(new Error(`SELECT secret FROM t; ${PROVIDER_TEXT}`)),
        );
      },
    });
    const harness = recipeHarness(throwing, { agents: {} });
    expect(await harness.start()).toMatchObject({ status: 'failed', error: 'step_failed' });
    expect(JSON.stringify(harness.state())).not.toContain('secret');
  });

  it('an approval decided outside the recipe fails with approval_decided_outside_recipe', async () => {
    const harness = recipeHarness(triageIncident, {
      agents: { triage: [completed({ severity: 'high' })], responder: [awaitingApproval()] },
    });
    await harness.start({ title: 'db down' });
    harness.decideOutside('escalate');

    await harness.runner().resume();

    expect(harness.state().runs[0]).toMatchObject({
      status: 'failed',
      error: 'approval_decided_outside_recipe',
    });
    expect(harness.state().steps.find((step) => step.key === 'escalate')?.error).toBe(
      'approval_decided_outside_recipe',
    );
  });

  it('an expired approval fails with approval_expired', async () => {
    const harness = recipeHarness(triageIncident, {
      agents: { triage: [completed({ severity: 'high' })], responder: [awaitingApproval()] },
    });
    await harness.start({ title: 'db down' });
    harness.expireApproval('escalate');

    await harness.runner().resume();

    expect(harness.state().runs[0]).toMatchObject({ status: 'failed', error: 'approval_expired' });
  });

  it('a decision on an expired approval fails the step with approval_expired', async () => {
    const harness = recipeHarness(triageIncident, {
      agents: { triage: [completed({ severity: 'high' })], responder: [awaitingApproval()] },
    });
    await harness.start({ title: 'db down' });
    harness.expireApproval('escalate');

    expect(await harness.approve('escalate')).toMatchObject({
      status: 'failed',
      error: 'approval_expired',
    });
    await expect(harness.approve('escalate')).rejects.toMatchObject({
      code: 'recipe_step_not_waiting',
    });
  });

  it('onRunOutcome wakes the waiting step', async () => {
    // The app crashed while its step waited on the run; the new process's timer has not fired yet,
    // so the run-outcome webhook is what wakes the recipe.
    const again = recipeHarness(twoSteps, {
      agents: { triage: [completed({ severity: 'high' })], notifier: [completed('done')] },
    });
    again.crashAfter('triage');
    await again.start();
    const triageRun = again.platformRuns()[0];
    if (triageRun === undefined) throw new Error('no triage run');
    again.advance(60_001);
    const fresh = again.replica();
    await fresh.onRunOutcome({
      id: crypto.randomUUID(),
      type: 'run.completed',
      createdAt: '2026-01-01T00:01:00.000Z',
      workspaceId: FAKE_WORKSPACE_ID,
      data: {
        run: {
          id: triageRun.id,
          agentId: triageRun.agentId,
          sessionId: triageRun.sessionId,
          status: 'completed',
          endedAt: triageRun.endedAt,
          error: null,
          usage: triageRun.usage,
          cost: triageRun.cost,
          accountingState: triageRun.accountingState,
        },
      },
    });

    expect(again.state().runs[0]?.status).toBe('completed');
    expect(again.platformRuns()).toHaveLength(2);
  });

  it('onRunOutcome refuses an event that is not a run outcome', async () => {
    const harness = recipeHarness(twoSteps, { agents: {} });
    await expect(
      harness.runner().onRunOutcome({ type: 'run.completed' } as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('onResourceEvent starts each matching recipe once per row and event', async () => {
    const onUpdate = defineRecipe({
      name: 'on-update',
      on: resourceEvent('ticket', 'updated'),
      run: () => Promise.resolve(),
    });
    const onCreate = defineRecipe({
      name: 'on-create',
      on: resourceEvent('ticket', 'created'),
      async run({ input, person }) {
        expect((input as { record: { id: string } }).record.id).toBe('t-1');
        expect(person).toEqual({ principalId: 'p-1' });
        return Promise.resolve();
      },
    });
    const harness = recipeHarness(onCreate, { agents: {}, recipes: [onUpdate] });
    const runner = harness.runner();
    const row = { id: 't-1', title: 'printer', updated_at: '2026-01-01T00:00:00.000Z' };

    const first = await runner.onResourceEvent('ticket', 'created', row, { principalId: 'p-1' });
    const second = await runner.onResourceEvent('ticket', 'created', row, { principalId: 'p-1' });
    await runner.onResourceEvent('ticket', 'updated', row);
    await runner.onResourceEvent('ticket', 'updated', {
      ...row,
      updated_at: '2026-01-01T00:00:01.000Z',
    });
    await runner.onResourceEvent('ticket', 'deleted', row);
    await runner.drain();

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    const runs = harness.state().runs;
    expect(runs.map((run) => run.dedupeKey)).toEqual([
      'resource:ticket:t-1:created',
      'resource:ticket:t-1:updated:2026-01-01T00:00:00.000Z',
      'resource:ticket:t-1:updated:2026-01-01T00:00:01.000Z',
    ]);
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
  });

  it('a runner over an SDK without idempotencyKey throws platform_lacks_idempotent_start', async () => {
    const oldSdk: typeof createClient = (options) => {
      const client = createClient(options);
      const start = client.runs.start.bind(client.runs);
      return {
        ...client,
        runs: Object.assign(Object.create(client.runs) as typeof client.runs, {
          start: (agentId: string, input: Parameters<typeof start>[1]) => {
            const { idempotencyKey: _dropped, ...rest } = input;
            void _dropped;
            return start(agentId, rest);
          },
        }),
      };
    };
    const runner = recipeRunner(
      { recipes: [twoSteps] },
      {
        client: createClient({
          baseUrl: 'https://aw.test',
          auth: { kind: 'api-key', apiKey: 'k' },
        }),
        store: memoryRecipeStore(),
        workspaceId: FAKE_WORKSPACE_ID,
        sdk: { createClient: oldSdk },
      },
    );
    await expect(runner.resume()).rejects.toBeInstanceOf(RecipeError);
    await expect(runner.start(twoSteps, {})).rejects.toMatchObject({
      code: 'platform_lacks_idempotent_start',
    });
  });

  it('refuses a recipe the app does not have and an input its schema refuses', async () => {
    const harness = recipeHarness(triageIncident, { agents: {} });
    await expect(harness.runner().start(twoSteps as DefinedRecipe, {})).rejects.toMatchObject({
      code: 'recipe_not_found',
    });
    await expect(harness.start({ title: 3 })).rejects.toMatchObject({
      code: 'recipe_input_invalid',
    });
  });
});

describe('recipeRunner fireSlot and clock (ADR-0164 T1–T2, #2077)', () => {
  const hourly = defineRecipe({
    name: 'hourly',
    on: schedule('0 * * * *'),
    async run({ aw, step, input }) {
      await step('digest', async () => {
        await aw.runs.start('digest', { prompt: `digest ${(input as { slot: string }).slot}` });
        return undefined;
      });
    },
  });

  it('starts exactly one recipe run per slot, and a second fire of the same instant starts none', async () => {
    const harness = recipeHarness(hourly, {
      agents: { digest: [completed('one'), completed('two')] },
    });
    const at = new Date('2026-03-04T05:06:07.000Z');

    const first = await harness.fireSlot(at);
    const again = await harness.fireSlot(new Date(at.getTime()));

    expect(again.id).toBe(first.id);
    expect(harness.state().runs).toHaveLength(1);
    expect(harness.state().runs[0]).toMatchObject({
      status: 'completed',
      dedupeKey: 'schedule:hourly:2026-03-04T05:06:07.000Z',
      input: { slot: '2026-03-04T05:06:07.000Z' },
      startedBy: null,
    });
    expect(harness.platformRuns()).toHaveLength(1);
  });

  it('a fired slot and the schedule reaching the same slot start one recipe run', async () => {
    const harness = recipeHarness(hourly, {
      agents: { digest: [completed('one'), completed('two')] },
      startAt: new Date('2026-01-01T00:30:00.000Z'),
    });
    await harness.fireSlot(new Date('2026-01-01T01:00:00.000Z'));
    harness.advance(31 * 60_000);
    await harness.runner().resume();

    expect(harness.state().runs).toHaveLength(1);
    expect(harness.platformRuns()).toHaveLength(1);
  });

  it('an injected clock moves the schedule evaluation', async () => {
    const clock = testClock('2026-01-01T00:30:00.000Z');
    const harness = recipeHarness(hourly, { agents: { digest: [completed('one')] }, clock });

    await harness.runner().resume();
    expect(harness.state().runs).toHaveLength(0);
    clock.set('2026-01-01T01:00:00.000Z');
    await harness.runner().resume();

    expect(harness.state().runs.map((run) => run.dedupeKey)).toEqual([
      'schedule:hourly:2026-01-01T01:00:00.000Z',
    ]);
  });

  it('refuses a recipe that is not a schedule, and an unknown one, by name', async () => {
    const harness = recipeHarness(twoSteps, { agents: {}, recipes: [hourly] });
    const at = new Date('2026-01-01T01:00:00.000Z');

    await expect(harness.runner().fireSlot('two-steps', at)).rejects.toMatchObject({
      name: 'RecipeError',
      code: 'recipe_not_schedule',
    });
    await expect(harness.runner().fireSlot('no-such', at)).rejects.toMatchObject({
      code: 'recipe_not_found',
    });
    expect(harness.state().runs).toHaveLength(0);
  });
});
