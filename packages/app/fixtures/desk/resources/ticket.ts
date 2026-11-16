import { defineResource, enumOf, text } from '@indx-workspace/app';

/**
 * The desk's one resource: a service-desk ticket, on a board by status. Every member may read and
 * change one, and an agent acting for a member may change its assignee and status.
 */
const ticket = defineResource({
  name: 'ticket',
  fields: {
    number: text({ max: 20 }),
    summary: text({ max: 200 }),
    status: enumOf(['new', 'triaged', 'closed'], { default: 'new' }),
    assignee: text({ max: 80, optional: true }),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: ['assignee', 'status'] },
  board: 'status',
});

export default ticket;
