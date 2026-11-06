import { defineResource, text } from '@indx-workspace/app';

export default defineResource({
  name: 'company',
  fields: {
    name: text(),
    domain: text(),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the company_update tool.
  agents: { read: true, write: ['name', 'domain'] },
  search: ['name', 'domain'],
});
