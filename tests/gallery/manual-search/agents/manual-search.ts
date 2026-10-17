import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'manual-search',
  instructions: { file: './manual-search.md' },
  model: 'default',
  engine: 'claude-agent-sdk',
  // Read-only by construction: it can read the manuals and call the index, nothing else.
  permissions: { readFiles: true },
  tools: [mcp('manual-index')],
  skills: [skill('cite-answer')],
  files: [files('manuals', 'read')],
  limits: { maxTurns: 12, maxBudgetUsd: 0.5 },
});
