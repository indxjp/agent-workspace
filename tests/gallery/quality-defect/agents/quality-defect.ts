import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'quality-defect',
  instructions: { file: './quality-defect.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval prompt.
  engine: { id: 'claude-agent-sdk', autoApprove: ['mcp__agent-workspace__run_skill_script'] },
  // Reads the FMEA and runs the eight-d check script; no writes, no network (the project
  // ceiling forbids both whatever this file says).
  permissions: { readFiles: true, runCommands: true, unrestrictedNetwork: false },
  tools: [mcp('defect-db')],
  skills: [skill('eight-d')],
  files: [files('fmea', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 1 },
});
