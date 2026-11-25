import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// It reads the document in `refund/inbox` (office-reader prints Word, Excel and PDF as JSON),
// checks each item against `refund/standards`, and writes the report to `refund-reports` with
// `Write`. Both folders are the entry's own, so two entries never share one, and the input folder is
// read-only. Only `search_files` runs unasked: a skill script may write wherever the agent may
// (`refund-reports`), so `run_skill_script` waits for a person like `Write` does (ADR-0167 D5,
// #2388). The typed verdicts are the `outputSchema` a run asks for (an eval case, a trigger or
// `runs.start`), not part of the agent.
export default defineAgent({
  name: 'refund',
  instructions: { file: './refund.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write', 'mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('refund')],
  files: [files('refund', 'read'), files('refund-reports', 'read-write')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
