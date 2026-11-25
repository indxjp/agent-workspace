import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// It reads the document in `expense/inbox` (office-reader prints Word, Excel and PDF as JSON),
// checks each item against `expense/standards`, and writes the report to `expense-reports` with
// `Write`. Both folders are the entry's own, so two entries never share one, and the input folder is
// read-only. Only `search_files` runs unasked: a skill script may write wherever the agent may
// (`expense-reports`), so `run_skill_script` waits for a person like `Write` does (ADR-0167 D5,
// #2388). The typed verdicts are the `outputSchema` a run asks for (an eval case, a trigger or
// `runs.start`), not part of the agent.
export default defineAgent({
  name: 'expense',
  instructions: { file: './expense.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write', 'mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('expense')],
  files: [files('expense', 'read'), files('expense-reports', 'read-write')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
