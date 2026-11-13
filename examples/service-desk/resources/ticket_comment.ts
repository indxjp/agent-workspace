import { bool, defineResource, ref, richText } from '@indx-workspace/app';

export default defineResource({
  name: 'ticket_comment',
  fields: {
    ticket: ref('ticket'),
    body: richText(),
    internal: bool(),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the ticket_comment_update tool.
  agents: { read: true, write: ['ticket', 'body', 'internal'] },
  search: ['body'],
});
