import { defineResource, enumOf, person, richText, text } from '@indx-workspace/app';

export default defineResource({
  name: 'ticket',
  fields: {
    title: text(),
    description: richText(),
    status: enumOf(['new', 'in_progress', 'on_hold', 'resolved', 'closed']),
    priority: enumOf(['p1', 'p2', 'p3', 'p4']),
    requester: person(),
    assignee: person(),
  },
  // A recipe step's run (triage) is started with the app's key and asserts its person as an
  // api-key subject, which holds no role (ADR-0142 D2): the requester rule is what lets triage
  // read and update the ticket of the person who opened it.
  access: {
    read: ['member', 'requester'],
    create: 'member',
    update: ['member', 'requester'],
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the ticket_update tool.
  agents: { read: true, write: ['status', 'priority', 'assignee'] },
  search: ['title', 'description'],
  board: 'status',
});
