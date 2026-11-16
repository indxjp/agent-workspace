import { defineRecipe, schedule, type ScheduleInput } from '@indx-workspace/app';

import { agentIdOf } from '../lib/agent-ids.ts';
import ticket from '../resources/ticket.ts';
import ticketComment from '../resources/ticket_comment.ts';
import { isBreached, OPEN_STATUSES, raised } from './sla-rule.ts';

/** The sweep was started with no SLA_ON_CALL_MEMBER, so it has nobody to act for. */
export class OnCallMemberMissing extends Error {
  override readonly name = 'OnCallMemberMissing';
  constructor() {
    super('SLA_ON_CALL_MEMBER is not set: name the on-call member the SLA sweep acts for');
  }
}

/**
 * The member the sweep acts for: a schedule has no person, so it reads and writes as the one
 * member SLA_ON_CALL_MEMBER names (ADR-0164), within that member's access. Without one it refuses
 * to run rather than borrow anyone's authority, an Owner's least of all.
 * shortcut: one configured member; upgrade to an on-call rota.
 */
function onCallMember(): string {
  const configured = process.env['SLA_ON_CALL_MEMBER'];
  if (configured === undefined || configured === '') throw new OnCallMemberMissing();
  return configured;
}

/**
 * SLA sweep: every five minutes, each open ticket past its SLA is escalated: a priority up, back
 * to in_progress, with an internal comment from `triage`. Each ticket is its own step, so running
 * a slot again escalates nobody twice.
 */
export default defineRecipe({
  name: 'sla-sweep',
  on: schedule('*/5 * * * *', 'UTC'),
  async run({ aw, input, step, store }) {
    const now = new Date((input as ScheduleInput).slot);
    const actingFor = onCallMember();
    const breached = await step(
      'scan',
      async () => {
        const pages = await Promise.all(
          OPEN_STATUSES.map((status) => store(ticket).list({ where: { status }, limit: 200 })),
        );
        return pages
          .flatMap((page) => page.items)
          .filter((row) => isBreached(row, now))
          .map((row) => ({ id: row.id, priority: row.priority }));
      },
      { actingFor },
    );
    for (const { id, priority } of breached) {
      await step(
        `escalate.${id}`,
        async () => {
          const prompt = `Ticket ${id} is open past its ${priority} SLA: write one line for its assignee.`;
          const { result } = await aw.runs.start(await agentIdOf(aw, 'triage'), { prompt });
          const { text } = await result;
          await store(ticket).update(id, { priority: raised(priority), status: 'in_progress' });
          const body = [{ type: 'paragraph', text: `SLA breached, escalated: ${text}` }];
          await store(ticketComment).create({ ticket: id, body, internal: true });
          return id;
        },
        { actingFor },
      );
    }
  },
});
