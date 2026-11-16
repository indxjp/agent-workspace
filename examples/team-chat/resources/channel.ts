import { defineResource, enumOf, text } from '@indx-workspace/app';

export default defineResource({
  name: 'channel',
  fields: {
    name: text(),
    kind: enumOf(['public', 'private', 'dm']),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the channel_update tool.
  agents: { read: true, write: false },
  search: ['name'],
});
