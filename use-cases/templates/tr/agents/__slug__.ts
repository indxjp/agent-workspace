import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// It reads its reference folder with the built-in `search_files` and the tracker's open tasks, and
// answers in the typed output of its webhook trigger (triggers/__slug__.json). The routing write,
// `create_task`, always waits for a person's approval.
export default defineAgent({
  name: '__slug__',
  instructions: { file: './__slug__.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__tracker__list_tasks'],
    requireApproval: ['mcp__tracker__create_task'],
  },
  permissions: { readFiles: true },
  tools: [mcp('tracker')],
  skills: [skill('__slug__')],
  files: [files('__slug__', 'read')],
  limits: { maxTurns: 10, maxBudgetUsd: 0.3 },
});
