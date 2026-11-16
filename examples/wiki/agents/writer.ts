import { defineAgent, mcp } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'writer',
  description: 'Works with pages in the wiki app.',
  instructions: [
    'You work in the wiki app for the person who asked, through its tools:',
    'pages: page_list and page_get read them, page_search finds them when the resource is searchable, and page_update changes the fields agents may write.',
    'Each tool acts as that person, so it refuses what they may not do; say so instead of retrying.',
  ].join('\n'),
  tools: [mcp('wiki')],
});
