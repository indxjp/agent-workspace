import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Analysis (AN), the rebuild of the gallery's Excel consolidation. It finds the branch workbooks in
// `excel-consolidation` with `search_files`, consolidates them with the `excel-consolidation`
// skill's script (office-reader's table reader, ADR-0173), which also writes the consolidated table
// as an office-writer model to `outputs/`, and renders the workbook with `office-writer`. It writes,
// so `run_skill_script` is never auto-approved (ADR-0167 D5, #2388): the consolidation, run on the
// plan the agent shows first, waits for a person, and so does the render. Only `search_files` runs
// unasked. The typed answer is the `outputSchema` a run asks for.
export default defineAgent({
  name: 'excel-consolidation',
  instructions: { file: './excel-consolidation.md' },
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  skills: [
    builtinSkill('office-reader'),
    builtinSkill('office-writer'),
    skill('excel-consolidation'),
  ],
  files: [files('excel-consolidation', 'read')],
  limits: { maxTurns: 20, maxBudgetUsd: 1 },
});
