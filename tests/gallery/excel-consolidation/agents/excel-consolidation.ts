import { defineAgent, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'excel-consolidation',
  instructions: { file: './excel-consolidation.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK refuses the skill script's Bash call.
  engine: { id: 'claude-agent-sdk', autoApprove: ['Bash'] },
  // It runs the two skills' Node scripts, so it needs runCommands. It does not need the Write tool:
  // the scripts print JSON, and the answer carries the report back to the backend.
  permissions: { readFiles: true, runCommands: true },
  tools: [mcp('file-finder')],
  skills: [skill('office-reader'), skill('excel-consolidate')],
  limits: { maxTurns: 30, maxBudgetUsd: 1 },
});
