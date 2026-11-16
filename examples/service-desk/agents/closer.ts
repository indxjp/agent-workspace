import { defineAgent, mcp } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'closer',
  description: 'Works with tickets in the service-desk app.',
  instructions: [
    'You work in the service-desk app for the person who asked, through its tools:',
    'tickets: ticket_list and ticket_get read them, ticket_search finds them when the resource is searchable, and ticket_update changes the fields agents may write.',
    'Each tool acts as that person, so it refuses what they may not do; say so instead of retrying.',
  ].join('\n'),
  tools: [mcp('service-desk')],
  engine: { id: 'claude-agent-sdk', requireApproval: ['mcp__service-desk__ticket_update'] },
});
