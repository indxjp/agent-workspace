import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'meeting-minutes',
  instructions: { file: './meeting-minutes.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval prompt.
  engine: { id: 'claude-agent-sdk', autoApprove: ['mcp__agent-workspace__run_skill_script'] },
  // runCommands offers run_skill_script, which runs the skill's date script; the agent writes no files. It can call create_task,
  // but the tracker accepts a write only with an approval token the backend issues (mcp/approval.mjs).
  permissions: { readFiles: true, runCommands: true },
  tools: [mcp('task-tracker')],
  skills: [skill('gijiroku-format')],
  files: [files('transcripts', 'read')],
  limits: { maxTurns: 20, maxBudgetUsd: 0.5 },
});
