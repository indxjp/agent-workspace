import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'contract-review',
  instructions: { file: './contract-review.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval prompt.
  engine: { id: 'claude-agent-sdk', autoApprove: ['mcp__agent-workspace__run_skill_script'] },
  // It reads the playbook and runs the skill script, which reads the draft itself; it writes
  // nothing and reaches no network. `runCommands` is what offers `run_skill_script`, which runs `clauses.mjs`.
  permissions: { readFiles: true, runCommands: true },
  skills: [skill('contract-playbook')],
  files: [files('contracts', 'read'), files('playbook', 'read')],
  limits: { maxTurns: 20, maxBudgetUsd: 1 },
});
