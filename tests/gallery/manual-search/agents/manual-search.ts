import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'manual-search',
  instructions: { file: './manual-search.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the tools' calls on an approval prompt.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__run_skill_script', 'mcp__agent-workspace__search_files'],
  },
  // Read-only by construction: it searches the manuals with the platform's `search_files` and
  // reads the PDF through office-reader, nothing else. The portal narrows each run to the manuals
  // the signed-in person may read (`runs.start({ fileScope })`). `runCommands` is what offers
  // `run_skill_script`; no write, no network.
  permissions: { readFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('cite-answer')],
  files: [files('manuals', 'read')],
  limits: { maxTurns: 12, maxBudgetUsd: 0.5 },
});
