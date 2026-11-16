import { defineResource, richText, tags, text } from '@indx-workspace/app';

export default defineResource({
  name: 'kb_article',
  fields: {
    title: text(),
    body: richText(),
    tags: tags(),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. List the fields they may
  // change, such as write: ['status'], to give them the kb_article_update tool.
  agents: { read: true, write: false },
  search: ['title', 'body'],
});
