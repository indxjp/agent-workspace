import { defineResource, person, ref, text } from '@indx-workspace/app';

export default defineResource({
  name: 'contact',
  fields: {
    name: text(),
    email: text(),
    company: ref('company', { optional: true }),
    owner: person(),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the contact_update tool.
  agents: { read: true, write: ['company'] },
  search: ['name', 'email'],
});
