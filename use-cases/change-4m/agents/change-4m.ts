import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// It reads the document in `change-4m/inbox` (office-reader prints Word, Excel and PDF as JSON),
// checks each item against `change-4m/standards`, and writes the report to `change-4m-reports` with
// `Write`. Both folders are the entry's own, so two entries never share one, and the input folder is
// read-only. Only `search_files` runs unasked: a skill script may write wherever the agent may
// (`change-4m-reports`), so `run_skill_script` waits for a person like `Write` does (ADR-0167 D5,
// #2388). The typed verdicts are the `outputSchema` a run asks for (an eval case, a trigger or
// `runs.start`), not part of the agent.
export default defineAgent({
  name: 'change-4m',
  instructions: { file: './change-4m.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write', 'mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('change-4m')],
  files: [files('change-4m', 'read'), files('change-4m-reports', 'read-write')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
