import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { completed, fakePerson, recipeHarness } from '@indx-workspace/app/testing';

import recipe from '../../recipes/sla-sweep.ts';
import ticket from '../../resources/ticket.ts';
import ticketComment from '../../resources/ticket_comment.ts';

const TRIAGE = '00000000-0000-4000-8000-0000000000b1';
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  process.env['AW_TRIAGE_AGENT_ID'] = TRIAGE;
});

afterEach(() => {
  delete process.env['SLA_ON_CALL_MEMBER'];
});

/** A harness whose on-call member is its person, with one open ticket of `priority`. */
async function deskWith(priority: 'p1' | 'p3') {
  const harness = recipeHarness(recipe, {
    agents: { [TRIAGE]: [completed('Call the VPN vendor.')] },
  });
  process.env['SLA_ON_CALL_MEMBER'] = harness.personId;
  const requester = fakePerson({ principalId: harness.personId });
  const created = await harness.storeOf(ticket).create(requester, {
    title: 'VPN down',
    description: [{ type: 'paragraph', text: 'Nobody can connect.' }],
    status: 'new',
    priority,
    requester: harness.personId,
    assignee: harness.personId,
  });
  return { harness, id: created.id };
}

/** The sweep of the slot at the harness clock, started as the schedule starts it. */
function sweep(harness: ReturnType<typeof recipeHarness>, slot: string) {
  return harness.start({ slot }, { person: null, dedupeKey: `schedule:sla-sweep:${slot}` });
}

void test('a breached p1 is escalated once per slot', async () => {
  const { harness, id } = await deskWith('p1');
  harness.advance(2 * HOUR_MS);
  const slot = new Date(Date.parse('2026-01-01T00:00:00.000Z') + 2 * HOUR_MS).toISOString();

  harness.crashAfter(`escalate.${id}`);
  await sweep(harness, slot);
  await harness.restart();
  const again = await sweep(harness, slot);

  assert.equal(again.status, 'completed');
  assert.equal(harness.runsStarted().length, 1);
  const escalated = await harness.storeOf(ticket).get(fakePerson(), id);
  assert.equal(escalated.status, 'in_progress');
  assert.equal(escalated.priority, 'p1');
  const comments = await harness.storeOf(ticketComment).list(fakePerson(), {});
  assert.equal(comments.items.length, 1);
  assert.equal(comments.items[0]?.internal, true);
  const [escalation] = harness.storeOf(ticket).auditEvents().slice(1);
  assert.equal(escalation?.via, 'agent');
  assert.equal(escalation?.run_id, harness.platformRuns()[0]?.id);
});

void test('an unbreached ticket is left alone', async () => {
  const { harness, id } = await deskWith('p3');
  harness.advance(2 * HOUR_MS);

  const run = await sweep(harness, '2026-01-01T02:00:00.000Z');

  assert.equal(run.status, 'completed');
  assert.equal(harness.runsStarted().length, 0);
  assert.equal((await harness.storeOf(ticket).get(fakePerson(), id)).status, 'new');
  assert.equal((await harness.storeOf(ticketComment).list(fakePerson(), {})).items.length, 0);
});

void test('with no on-call member configured the sweep refuses to run, acting for nobody', async () => {
  const { harness, id } = await deskWith('p1');
  delete process.env['SLA_ON_CALL_MEMBER'];
  harness.advance(2 * HOUR_MS);

  const run = await sweep(harness, '2026-01-01T02:00:00.000Z');

  assert.equal(run.status, 'failed');
  assert.equal(harness.runsStarted().length, 0);
  assert.equal((await harness.storeOf(ticket).get(fakePerson(), id)).status, 'new');
  assert.equal(harness.storeOf(ticket).auditEvents().length, 1);
  assert.equal((await harness.storeOf(ticketComment).list(fakePerson(), {})).items.length, 0);
});
