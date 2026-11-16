import { defineResource, enumOf, money, person, text } from '@indx-workspace/app';

export default defineResource({
  name: 'deal',
  fields: {
    name: text(),
    amount: money({ currency: 'JPY' }),
    stage: enumOf(['lead', 'qualified', 'proposal', 'won', 'lost']),
    owner: person(),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the deal_update tool.
  agents: { read: true, write: ['stage'] },
  search: ['name'],
  board: 'stage',
});
