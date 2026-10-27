import { defineAgent, skill } from '@indx-workspace/sdk/define';

import { erp } from '../tools/erp.ts';

export default defineAgent({
  name: 'quotation',
  instructions: { file: './quotation.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval
  // prompt, whether the model runs it through run_skill_script or through Bash.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['Bash', 'mcp__agent-workspace__run_skill_script'],
  },
  // runCommands runs the cost-model script; the one write is the ERP's createQuote, which waits for approval.
  permissions: { readFiles: true, runCommands: true },
  tools: [erp],
  skills: [skill('cost-model')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
