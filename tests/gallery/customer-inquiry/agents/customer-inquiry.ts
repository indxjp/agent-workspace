import { defineAgent, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'customer-inquiry',
  instructions: { file: './customer-inquiry.md' },
  model: 'default',
  engine: 'claude-agent-sdk',
  // Nothing but the CRM server: no files, no commands, no network. Everything the agent knows about
  // a customer comes through crm-history, which checks the token and masks personal data.
  permissions: {},
  tools: [mcp('crm-history')],
  skills: [skill('keigo-reply')],
  limits: { maxTurns: 10, maxBudgetUsd: 0.3 },
});
