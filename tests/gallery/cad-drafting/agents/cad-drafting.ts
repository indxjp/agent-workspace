import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'cad-drafting',
  instructions: { file: './cad-drafting.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval prompt.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__run_skill_script', 'Write'],
  },
  // It runs the skill's script to write a draft, so it needs commands and file writes; the grants
  // below keep the writes to `drafts`: past drawings are read-only.
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  tools: [mcp('drawing-index')],
  skills: [skill('dxf-draft')],
  files: [files('drawings', 'read'), files('drafts', 'read-write')],
  limits: { maxTurns: 20, maxBudgetUsd: 1 },
});
