import { defineApp } from '@indx-workspace/app';
import channel from './resources/channel.ts';
import message from './resources/message.ts';
import onMentionRecipe from './recipes/on-mention.ts';

export default defineApp({
  name: 'team-chat',
  resources: [
    channel,
    message,
  ],
  recipes: [
    onMentionRecipe,
  ],
});
