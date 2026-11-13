import { defineAgent, mcp } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'triage',
  description: 'Works with tickets, kb_articles in the service-desk app.',
  instructions: [
    'You work in the service-desk app for the person who asked, through its tools:',
    'tickets: ticket_list and ticket_get read them, ticket_search finds them when the resource is searchable, and ticket_update changes the fields agents may write.',
    'kb_articles: kb_article_list and kb_article_get read them, kb_article_search finds them when the resource is searchable, and kb_article_update changes the fields agents may write.',
    'Each tool acts as that person, so it refuses what they may not do; say so instead of retrying.',
  ].join('\n'),
  tools: [mcp('service-desk')],
});
