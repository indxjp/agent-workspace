import { defineResource, ref, text } from '@indx-workspace/app';

/**
 * The desk's chat messages (issue #1519): each in a room, the key of the `message` channel, and
 * a reply naming its thread's first message. An agent acting for a member may edit a body.
 */
const message = defineResource({
  name: 'message',
  fields: {
    room: ref('room'),
    body: text({ max: 4000 }),
    thread_root: ref('message', { optional: true }),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  agents: { read: true, write: ['body'] },
});

export default message;
