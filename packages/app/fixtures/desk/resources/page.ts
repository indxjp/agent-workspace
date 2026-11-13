import { definePages } from '@indx-workspace/app';

/**
 * The desk's knowledge base (issue #1521): pages that nest, with revisions. Every member may read
 * and change one, and an agent acting for a member may change its title and body.
 */
const page = definePages({
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: ['title', 'blocks'] },
});

export default page;
