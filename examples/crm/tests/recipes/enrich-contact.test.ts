// enrich-contact, run end to end on the recipe harness: the scripted sales assistant answers the
// structured classification, and the recipe's store links the contact as the person's agent.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { completed, fakePerson, recipeHarness } from '@indx-workspace/app/testing';

import recipe from '../../recipes/enrich-contact.ts';
import company from '../../resources/company.ts';
import contact from '../../resources/contact.ts';

// The harness's platform has no agent list, so the recipe is given the agent's id.
const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
process.env['AW_ENRICH_CONTACT_AGENT_ID'] = AGENT_ID;

const OWNER = '00000000-0000-4000-8000-0000000000b1';
const ANSWER = { company: 'Example K.K.', title: 'Head of Sales' };

function harnessWith(answers: number) {
  return recipeHarness(recipe, {
    agents: { [AGENT_ID]: Array.from({ length: answers }, () => completed(ANSWER)) },
  });
}

async function createdContact(harness: ReturnType<typeof harnessWith>, email: string) {
  const created = await harness
    .storeOf(contact)
    .create(fakePerson(), { name: 'Aiko Tanaka', email, owner: OWNER });
  return { resource: 'contact', event: 'created', record: created };
}

async function companies(harness: ReturnType<typeof harnessWith>) {
  return (await harness.storeOf(company).list(fakePerson(), {})).items;
}

void test('free-mail is skipped', async () => {
  const harness = harnessWith(1);
  const input = await createdContact(harness, 'aiko@gmail.com');

  const run = await harness.start(input);

  assert.equal(run.status, 'completed');
  assert.equal(harness.runsStarted().length, 0);
  assert.deepEqual(await companies(harness), []);
  assert.equal(harness.storeOf(contact).calls.update, 0);
});

void test('an existing company is reused', async () => {
  const harness = harnessWith(1);
  const existing = await harness
    .storeOf(company)
    .create(fakePerson(), { name: 'Example', domain: 'example.co.jp' });
  const input = await createdContact(harness, 'aiko@example.co.jp');

  const run = await harness.start(input);

  assert.equal(run.status, 'completed');
  assert.equal(harness.runsStarted().length, 1);
  assert.deepEqual(
    (await companies(harness)).map((row) => row.id),
    [existing.id],
  );
  const linked = await harness.storeOf(contact).get(fakePerson(), input.record.id);
  assert.equal(linked.company, existing.id);
  // The link is the person's agent's write, carrying the run that produced it (ADR-0164).
  const [update] = harness
    .storeOf(contact)
    .auditEvents()
    .filter((event) => event.action === 'update');
  assert.equal(update?.via, 'agent');
  assert.equal(update?.actor, harness.personId);
  assert.equal(update?.run_id, harness.platformRuns()[0]?.id);
});

void test('a crash after classify does not start a second run', async () => {
  const harness = harnessWith(2);
  const input = await createdContact(harness, 'aiko@example.co.jp');
  harness.crashAfter('classify');

  await harness.start(input);
  await harness.restart();

  const [run] = harness.state().runs;
  assert.equal(run?.status, 'completed');
  assert.equal(harness.runsStarted().length, 1);
  const [created] = await companies(harness);
  assert.deepEqual(
    { name: created?.name, domain: created?.domain, count: (await companies(harness)).length },
    { name: 'Example K.K.', domain: 'example.co.jp', count: 1 },
  );
  const linked = await harness.storeOf(contact).get(fakePerson(), input.record.id);
  assert.equal(linked.company, created?.id);
});
