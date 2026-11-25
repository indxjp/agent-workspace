import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Analysis (AN), read-only by construction: it finds the export in `segments` with `search_files`,
// computes with the `segments` skill's script through `run_skill_script`, and answers in the typed
// output a run asks for (an eval case or `runs.start`), which the surface charts (ADR-0168). No
// grant is read-write and `writeFiles` is off, so no script can write and both calls may run
// unattended (ADR-0167 D5, #2388). The folder is named after the entry, so two entries' demo data
// never share one folder. The entry writes the calculation, `skills/segments/scripts/analyse.mjs`,
// and the flow that covers it: the script reads the CSV or .xlsx with office-reader's `readTable`
// and `runWhenMain` (ADR-0173, "Reading a table in a skill script" in use-cases/README.md), which
// the office-reader grant makes importable in a run.
export default defineAgent({
  name: 'segments',
  instructions: { file: './segments.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('segments')],
  files: [files('segments', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
