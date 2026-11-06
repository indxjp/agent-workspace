import { defineAgent, mcp } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'helper',
  description: 'Works with notes in the minimal app.',
  instructions: [
    'You work in the minimal app for the person who asked, through its tools:',
    'notes: note_list and note_get read them, note_search finds them when the resource is searchable, and note_update changes the fields agents may write.',
    'Each tool acts as that person, so it refuses what they may not do; say so instead of retrying.',
  ].join('\n'),
  tools: [mcp('minimal')],
});
