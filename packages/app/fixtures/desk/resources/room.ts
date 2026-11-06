import { defineResource, text } from '@indx-workspace/app';

/** The desk's chat rooms (issue #1519): a message's channel key. */
const room = defineResource({
  name: 'room',
  fields: { title: text({ max: 80 }) },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
});

export default room;
