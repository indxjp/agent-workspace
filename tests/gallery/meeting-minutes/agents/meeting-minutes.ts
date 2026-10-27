import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

import { tracker } from '../tools/tracker.ts';

export default defineAgent({
  name: 'meeting-minutes',
  instructions: { file: './meeting-minutes.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval prompt.
  engine: { id: 'claude-agent-sdk', autoApprove: ['mcp__agent-workspace__run_skill_script'] },
  // runCommands offers run_skill_script, which runs the skill's date script; the agent writes no
  // files. Its one write is the tracker's createTask, which the platform runs only for a call a
  // person approved.
  permissions: { readFiles: true, runCommands: true },
  tools: [mcp('task-tracker'), tracker],
  skills: [skill('gijiroku-format')],
  files: [files('transcripts', 'read')],
  limits: { maxTurns: 20, maxBudgetUsd: 0.5 },
});
