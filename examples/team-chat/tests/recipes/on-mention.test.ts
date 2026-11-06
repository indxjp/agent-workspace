// The on-mention recipe, offline: recipeHarness scripts the platform's runs and keeps the app's
// messages in memory stores that outlive a restart.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { markdownToBlocks } from '@indx-workspace/app';
import { completed, fakePerson, recipeHarness } from '@indx-workspace/app/testing';

import recipe from '../../recipes/on-mention.ts';
import message from '../../resources/message.ts';

const HELPER_ID = crypto.randomUUID();
const CHANNEL = crypto.randomUUID();

beforeEach(() => {
  process.env['AW_HELPER_AGENT_ID'] = HELPER_ID;
});

afterEach(() => {
  delete process.env['AW_HELPER_AGENT_ID'];
});

function harnessWith(...answers: string[]) {
  return recipeHarness(recipe, { agents: { [HELPER_ID]: answers.map((text) => completed(text)) } });
}

async function post(harness: ReturnType<typeof harnessWith>, text: string, threadRoot?: string) {
  const person = fakePerson({ principalId: harness.personId });
  return harness.storeOf(message).create(person, {
    channel: CHANNEL,
    body: markdownToBlocks(text),
    ...(threadRoot === undefined ? {} : { thread_root: threadRoot }),
  });
}

void test('a mention replies once in its thread, as the person’s agent, across a restart', async () => {
  const harness = harnessWith('Two pull requests were merged today.');
  const root = await post(harness, 'Standup is at ten.');
  harness.advance(1_000);
  const mention = await post(harness, '@helper what changed today?', root.id);

  harness.crashAfter('reply', 'run-started');
  await harness.start({ resource: 'message', event: 'created', record: mention });
  await harness.restart();

  const replies = (await harness.storeOf(message).list(fakePerson())).items.filter(
    (item) => item.id !== mention.id && item.thread_root === root.id,
  );
  assert.equal(harness.platformRuns().length, 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.channel, CHANNEL);
  assert.deepEqual(replies[0]?.body, markdownToBlocks('Two pull requests were merged today.'));
  const prompt = (harness.runsStarted()[0]?.json as { prompt: string }).prompt;
  assert.equal(prompt, 'Standup is at ten.\n\n@helper what changed today?');
  const audit = harness.storeOf(message).auditEvents().at(-1);
  assert.equal(audit?.via, 'agent');
  assert.equal(audit?.actor, harness.personId);
  assert.equal(audit?.run_id, harness.platformRuns()[0]?.id);
  assert.equal(harness.state().runs.at(-1)?.status, 'completed');
});

void test('a mention outside a thread starts its own thread', async () => {
  const harness = harnessWith('Nothing yet.');
  const mention = await post(harness, 'Hey @helper, anything new?');

  await harness.start({ resource: 'message', event: 'created', record: mention });

  const replies = (await harness.storeOf(message).list(fakePerson())).items.filter(
    (item) => item.thread_root === mention.id,
  );
  assert.equal(replies.length, 1);
});

void test('a message with no mention starts nothing', async () => {
  const harness = harnessWith();
  const plain = await post(harness, 'Lunch at noon? Ask helper@example.test.');

  const run = await harness.start({ resource: 'message', event: 'created', record: plain });

  assert.equal(run.status, 'completed');
  assert.equal(harness.runsStarted().length, 0);
});

void test('a reply whose answer mentions @helper starts no second run', async () => {
  const harness = harnessWith('Ask @helper again tomorrow, or write to @helper.');
  const mention = await post(harness, '@helper is the deploy done?');

  await harness.start({ resource: 'message', event: 'created', record: mention });
  const reply = (await harness.storeOf(message).list(fakePerson())).items.find(
    (item) => item.thread_root === mention.id,
  );
  assert.ok(reply);
  assert.deepEqual(reply.body, markdownToBlocks('Ask helper again tomorrow, or write to helper.'));

  // The reply is a committed message.created like any other: it must start nothing.
  const again = await harness.start({ resource: 'message', event: 'created', record: reply });

  assert.equal(again.status, 'completed');
  assert.equal(harness.platformRuns().length, 1);
  assert.equal(harness.runsStarted().length, 1);
});
