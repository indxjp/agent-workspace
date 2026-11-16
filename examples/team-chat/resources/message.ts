import { defineResource, files, ref, richText } from '@indx-workspace/app';

export default defineResource({
  name: 'message',
  fields: {
    channel: ref('channel'),
    body: richText(),
    attachments: files({ optional: true }),
    thread_root: ref('message', { optional: true }),
  },
  access: {
    read: 'member',
    create: 'member',
    update: 'member',
    delete: 'role:admin',
  },
  // Agents act for a person and never exceed that person's access. The on-mention recipe posts
  // the helper's answer as the person's agent, so agents write a message's channel, thread and body.
  agents: { read: true, write: ['channel', 'thread_root', 'body'] },
  search: ['body'],
});
