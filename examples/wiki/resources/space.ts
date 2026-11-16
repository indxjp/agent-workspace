import { defineResource, text } from '@indx-workspace/app';

// A space holds a tree of pages; every page names the space it belongs to.
export default defineResource({
  name: 'space',
  fields: {
    name: text({ max: 120 }),
  },
  access: {
    read: 'member',
    create: 'role:builder',
    update: 'role:builder',
    delete: 'role:admin',
  },
});
