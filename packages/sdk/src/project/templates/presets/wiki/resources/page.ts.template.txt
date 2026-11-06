import { definePages } from '@indx-workspace/app';

// The wiki's pages, kept in spaces: each nests under another, keeps a rich-text body and leaves a
// revision on every save. Agents act for a person and never exceed that person's access. Writing
// `title` and `blocks` gives them page_update; `page_create` also names the page's `space` and,
// under another page, its `parent`, so those are listed too (a page's update never moves it).
export default definePages({
  space: true,
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  agents: { read: true, write: ['title', 'blocks', 'parent', 'space'] },
});
