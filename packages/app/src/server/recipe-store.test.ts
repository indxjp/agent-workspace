/**
 * A recipe's `store` (ADR-0164): it writes the app's records as the person's agent, in the run of
 * the step it writes in, never beyond the person's access or `agents.write`, and a schedule writes
 * only as the member a step names with `actingFor`.
 */
import { describe, expect, it } from 'vitest';

import { enumOf, ref, text } from '../fields/index.js';
import { defineRecipe, resourceEvent, schedule, type RecipeContext } from '../recipe.js';
import { defineResource } from '../resource.js';
import { completed, recipeHarness } from '../testing/recipe-harness.js';

const channels = defineResource({
  name: 'channel',
  fields: { name: text({ max: 80 }) },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: false },
});

const messages = defineResource({
  name: 'message',
  fields: {
    channel: ref('channel'),
    body: text({ max: 4000 }),
    status: enumOf(['open', 'escalated'], { default: 'open' }),
  },
  access: { read: 'member', create: 'role:builder', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: ['channel', 'body'] },
});

const CHANNEL_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_MEMBER = '00000000-0000-4000-8000-0000000000bb';
const STRANGER = '00000000-0000-4000-8000-0000000000ee';

type Body = (context: RecipeContext<unknown>) => Promise<void>;

/** A recipe on `message.created` whose body is `run`. */
function onMessage(run: Body) {
  return defineRecipe({ name: 'on-message', on: resourceEvent('message', 'created'), run });
}

/** A schedule recipe whose body is `run`. */
function sweep(run: Body) {
  return defineRecipe({ name: 'sweep', on: schedule('*/5 * * * *'), run });
}

/** The reply step of the team-chat signature flow: one run, then its answer stored as a message. */
const reply: Body = async ({ aw, step, store }) => {
  await step('reply', async () => {
    const { result } = await aw.runs.start('helper', { prompt: 'what changed today?' });
    const answer = await result;
    await store(messages).create({ channel: CHANNEL_ID, body: answer.text });
    return answer.text;
  });
};

function helper(answer = 'Two tickets closed.') {
  return { helper: [completed(answer)] };
}

describe('a recipe store', () => {
  it("writes as the person's agent and carries the step's run_id", async () => {
    const harness = recipeHarness(onMessage(reply), { agents: helper() });

    const run = await harness.start();

    expect(run.status).toBe('completed');
    const [platformRun] = harness.platformRuns();
    const written = harness.storeOf(messages);
    expect(written.auditEvents()).toEqual([
      expect.objectContaining({
        actor: harness.personId,
        via: 'agent',
        run_id: platformRun?.id,
        resource: 'message',
        action: 'create',
      }),
    ]);
    const page = await written.list({
      principalId: harness.personId,
      workspaceId: run.workspaceId,
      role: 'builder',
      via: 'person',
    });
    expect(page.items.map((item) => item.body)).toEqual(['Two tickets closed.']);
    expect(page.items[0]?.created_by).toBe(harness.personId);
  });

  it('reads outside a step, as the person through an agent', async () => {
    let seen: readonly unknown[] = [];
    const harness = recipeHarness(
      onMessage(async ({ store }) => {
        seen = (await store(messages).list()).items;
      }),
      { agents: {} },
    );

    expect((await harness.start()).status).toBe('completed');
    expect(seen).toEqual([]);
  });

  it('refuses a write outside a step that started a run, by code', async () => {
    const outside = recipeHarness(
      onMessage(async ({ store }) => {
        await store(messages).create({ channel: CHANNEL_ID, body: 'hi' });
      }),
      { agents: {} },
    );
    expect(await outside.start()).toMatchObject({
      status: 'failed',
      error: 'recipe_write_needs_run',
    });

    const beforeRun = recipeHarness(
      onMessage(async ({ step, store }) => {
        await step('post', async () => {
          await store(messages).create({ channel: CHANNEL_ID, body: 'hi' });
          return null;
        });
      }),
      { agents: {} },
    );
    expect(await beforeRun.start()).toMatchObject({
      status: 'failed',
      error: 'recipe_write_needs_run',
    });
    expect(beforeRun.state().steps[0]).toMatchObject({
      status: 'failed',
      error: 'recipe_write_needs_run',
    });
    expect(beforeRun.storeOf(messages).calls.create).toBe(0);
  });

  it('refuses a field outside agents.write', async () => {
    const harness = recipeHarness(
      onMessage(async ({ aw, step, store }) => {
        await step('escalate', async () => {
          await aw.runs.start('helper', { prompt: 'escalate it' });
          await store(messages).create({ channel: CHANNEL_ID, body: 'up', status: 'escalated' });
          return null;
        });
      }),
      { agents: helper() },
    );

    expect(await harness.start()).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(harness.storeOf(messages).auditEvents()).toEqual([]);
  });

  it('refuses a member what their own access refuses, and a resource agents may not write', async () => {
    const viewer = recipeHarness(onMessage(reply), {
      agents: helper(),
      members: { '00000000-0000-4000-8000-0000000000aa': 'viewer' },
    });
    expect(await viewer.start()).toMatchObject({ status: 'failed', error: 'forbidden' });

    const noAgents = recipeHarness(
      onMessage(async ({ aw, step, store }) => {
        await step('rename', async () => {
          await aw.runs.start('helper', { prompt: 'name it' });
          await store(channels).create({ name: 'general' });
          return null;
        });
      }),
      { agents: helper() },
    );
    expect(await noAgents.start()).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(noAgents.storeOf(channels).auditEvents()).toEqual([]);
  });

  it('does not write twice when the app crashes after the step and restarts', async () => {
    const harness = recipeHarness(onMessage(reply), { agents: helper() });
    harness.crashAfter('reply');

    await harness.start();
    await harness.restart();

    expect(harness.state().runs[0]?.status).toBe('completed');
    expect(harness.runsStarted()).toHaveLength(1);
    expect(harness.storeOf(messages).auditEvents()).toHaveLength(1);
  });

  it('writes once when the app crashed after the run started and before it was recorded', async () => {
    const harness = recipeHarness(onMessage(reply), { agents: helper() });
    harness.crashAfter('reply', 'run-started');

    await harness.start();
    expect(harness.storeOf(messages).auditEvents()).toEqual([]);
    await harness.restart();

    expect(harness.state().runs[0]?.status).toBe('completed');
    expect(harness.platformRuns()).toHaveLength(1);
    expect(harness.storeOf(messages).auditEvents()).toEqual([
      expect.objectContaining({ run_id: harness.platformRuns()[0]?.id }),
    ]);
  });
});

describe('a schedule recipe store', () => {
  it('refuses every read and write outside a step with actingFor', async () => {
    const harness = recipeHarness(
      sweep(async ({ store }) => {
        await store(messages).list();
      }),
      { agents: {} },
    );

    expect(await harness.start({}, { person: null })).toMatchObject({
      status: 'failed',
      error: 'recipe_store_needs_person',
    });
  });

  it("writes as the actingFor member's agent, and the step's run asserts them", async () => {
    const harness = recipeHarness(
      sweep(async ({ aw, step, store }) => {
        await step(
          'escalate',
          async () => {
            const { result } = await aw.runs.start('helper', { prompt: 'summarise the breach' });
            await store(messages).create({ channel: CHANNEL_ID, body: (await result).text });
            return null;
          },
          { actingFor: OTHER_MEMBER },
        );
      }),
      { agents: helper('Breached.'), members: { [OTHER_MEMBER]: 'builder' } },
    );

    expect((await harness.start({}, { person: null })).status).toBe('completed');
    expect(harness.runsStarted()[0]?.json).toMatchObject({ subject: OTHER_MEMBER });
    expect(harness.storeOf(messages).auditEvents()).toEqual([
      expect.objectContaining({
        actor: OTHER_MEMBER,
        via: 'agent',
        run_id: harness.platformRuns()[0]?.id,
      }),
    ]);
  });

  it('refuses actingFor for a non-member, a malformed id, and in a recipe that has a person', async () => {
    const actingAs = (actingFor: string) =>
      sweep(async ({ step }) => {
        await step('noop', () => Promise.resolve(null), { actingFor });
      });
    for (const actingFor of [STRANGER, 'not-a-principal']) {
      const harness = recipeHarness(actingAs(actingFor), { agents: {} });
      expect(await harness.start({}, { person: null })).toMatchObject({
        status: 'failed',
        error: 'recipe_acting_for_refused',
      });
    }

    const personRun = recipeHarness(actingAs(OTHER_MEMBER), {
      agents: {},
      members: { '00000000-0000-4000-8000-0000000000aa': 'builder', [OTHER_MEMBER]: 'owner' },
    });
    expect(await personRun.start()).toMatchObject({
      status: 'failed',
      error: 'recipe_acting_for_refused',
    });
  });
});
