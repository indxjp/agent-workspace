import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'ringi-review',
  instructions: { file: './ringi-review.md' },
  model: 'default',
  engine: 'claude-agent-sdk',
  // Read-only by construction: it reads the rules and the archive and writes nothing. It cannot
  // approve a ringi because no tool it holds can, and the project's policy ceiling forbids
  // writing files, running commands and open network access for every agent in the project.
  permissions: { readFiles: true },
  tools: [mcp('ringi-archive')],
  skills: [skill('ringi-checklist')],
  files: [files('rules', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
