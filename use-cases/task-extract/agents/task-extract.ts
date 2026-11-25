import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// It reads its reference folder with the built-in `search_files` and the tracker's open tasks, and
// answers in the typed output of its webhook trigger (triggers/task-extract.json). The routing write,
// `create_task`, always waits for a person's approval.
export default defineAgent({
  name: 'task-extract',
  instructions: { file: './task-extract.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__tracker__list_tasks'],
    requireApproval: ['mcp__tracker__create_task'],
  },
  permissions: { readFiles: true },
  tools: [mcp('tracker')],
  skills: [skill('task-extract')],
  files: [files('task-extract', 'read')],
  limits: { maxTurns: 10, maxBudgetUsd: 0.3 },
});
