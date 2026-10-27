import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import { crm } from '../tools/crm.ts';

export default defineAgent({
  name: 'customer-inquiry',
  instructions: { file: './customer-inquiry.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the FAQ search on an approval prompt.
  // `handoff` offers `handoff_to_person`: the agent passes the customer to an operator with it.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    handoff: true,
  },
  // It reads the FAQ (the one granted folder) with the built-in `search_files` and the customer's
  // history through the read-only CRM tool; no write, no command, no network, no server of ours.
  permissions: { readFiles: true },
  tools: [crm],
  skills: [skill('keigo-reply')],
  files: [files('faq', 'read')],
  limits: { maxTurns: 10, maxBudgetUsd: 0.3 },
});
