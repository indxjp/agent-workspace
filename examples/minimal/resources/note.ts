import { defineResource, richText, text } from '@indx-workspace/app';

export default defineResource({
  name: 'note',
  fields: {
    title: text(),
    body: richText(),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the note_update tool.
  agents: { read: true, write: false },
  search: ['title', 'body'],
});
