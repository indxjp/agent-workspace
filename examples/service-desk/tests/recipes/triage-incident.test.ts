import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  awaitingApproval,
  completed,
  fakePerson,
  recipeHarness,
} from '@indx-workspace/app/testing';

import recipe from '../../recipes/triage-incident.ts';
import ticket from '../../resources/ticket.ts';
import ticketComment from '../../resources/ticket_comment.ts';

const TRIAGE = '00000000-0000-4000-8000-0000000000b1';
const CLOSER = '00000000-0000-4000-8000-0000000000b2';
const KB_ARTICLE = '00000000-0000-4000-8000-0000000000c1';
/** The call closer waits on: its gated ticket_update (agents/closer.ts). */
const CLOSE_CALL = {
  toolName: 'mcp__service-desk__ticket_update',
  canonicalCall: 'mcp__service-desk__ticket_update({"status":"closed"})',
};

beforeEach(() => {
  process.env['AW_TRIAGE_AGENT_ID'] = TRIAGE;
  process.env['AW_CLOSER_AGENT_ID'] = CLOSER;
});

/** A harness with a resolved ticket "VPN down" that triage finds a resolving article for. */
async function resolvedTicket(closerAfterDecision: string) {
  const harness = recipeHarness(recipe, {
    agents: {
      [TRIAGE]: [completed({ resolvable: true, kbArticleId: KB_ARTICLE, summary: 'Reset VPN' })],
      [CLOSER]: [awaitingApproval(CLOSE_CALL), completed(closerAfterDecision)],
    },
  });
  const requester = fakePerson({ principalId: harness.personId });
  const record = await harness.storeOf(ticket).create(requester, {
    title: 'VPN down',
    description: [{ type: 'paragraph', text: 'Nobody can connect.' }],
    status: 'resolved',
    priority: 'p1',
    requester: harness.personId,
    assignee: harness.personId,
  });
  const run = await harness.start({ resource: 'ticket', event: 'created', record });
  return { harness, run, id: record.id };
}

void test('closure waits for approval and closes on approve', async () => {
  const { harness, run } = await resolvedTicket('Closed the ticket.');

  assert.equal(run.status, 'waiting');
  const waiting = harness.state().steps.find((step) => step.key === 'approve-closure');
  assert.equal(waiting?.status, 'awaiting_approval');
  const [kbLink] = (await harness.storeOf(ticketComment).list(fakePerson(), {})).items;
  assert.equal(kbLink?.internal, true);
  const [linkAudit] = harness.storeOf(ticketComment).auditEvents();
  assert.equal(linkAudit?.run_id, harness.platformRuns()[0]?.id);

  const decided = await harness.approve('approve-closure');

  // The approved call is closer's own ticket_update, which closes the ticket; the recipe goes on.
  assert.equal(decided.status, 'completed');
  assert.deepEqual(
    harness.platformRuns().map((platformRun) => platformRun.agentId),
    [TRIAGE, CLOSER, CLOSER],
  );
  assert.equal(harness.platformRuns().at(-1)?.status, 'completed');
});

void test('a rejected closure leaves the ticket resolved', async () => {
  const { harness, id } = await resolvedTicket('Left the ticket open.');

  const decided = await harness.reject('approve-closure', 'The user still has no VPN.');

  assert.equal(decided.status, 'completed');
  assert.equal((await harness.storeOf(ticket).get(fakePerson(), id)).status, 'resolved');
  assert.equal(harness.storeOf(ticket).calls.update, 0);
});
