import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Grounded answers (QA), read-only by construction: it searches its own folder, `maintenance`, with
// the platform's `search_files`, reads PDF, Word and Excel files through `office-reader`, and cites
// every fact. A caller narrows each run to what that person may read with
// `runs.start({ fileScope })` (ADR-0147). No write, no network.
export default defineAgent({
  name: 'maintenance',
  instructions: { file: './maintenance.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops these read-only calls on a prompt.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('maintenance')],
  files: [files('maintenance', 'read')],
  limits: { maxTurns: 12, maxBudgetUsd: 0.5 },
});
