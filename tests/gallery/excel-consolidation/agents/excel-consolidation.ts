import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'excel-consolidation',
  instructions: { file: './excel-consolidation.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK refuses the search and the skill scripts. The
  // read-only grants below make the platform deny Bash, so scripts run through `run_skill_script`.
  // The only thing a person decides is the mapping plan: the agent saves it with `Write`, and the
  // run waits there for an approval (ADR-0145) before it applies the plan.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__run_skill_script', 'mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  // It runs the two skills' Node scripts, so it needs runCommands, and it writes the consolidated
  // workbook to `outputs/` (the folder the run collects), which the backend reads back with
  // `runs.outputs`; the answer still carries the report. Finding the workbooks is the platform's
  // `search_files` over the granted branch folders; the backend narrows it per person with
  // `runs.start({ fileScope })`, so a branch manager's run searches (and gets) only their own branch.
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('excel-consolidate')],
  files: [
    files('共通', 'read'),
    files('東京支店', 'read'),
    files('大阪支店', 'read'),
    files('名古屋営業所', 'read'),
    files('札幌営業所', 'read'),
    files('福岡支店', 'read'),
  ],
  limits: { maxTurns: 30, maxBudgetUsd: 1 },
});
