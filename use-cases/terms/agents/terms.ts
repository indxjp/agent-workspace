import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// It reads the notes and sources under `terms/` (one folder per language), writes the document
// model to `drafts/` in its session folder, and renders it with `office-writer` to `outputs/`, which
// the run returns. The render is the one write a person approves: `run_skill_script` waits, and is
// never auto-approved (ADR-0167 D5, #2388), and the platform denies a plain `Write` under `outputs/`
// to an office-writer agent (#2420); only `search_files` runs unasked. The typed outline is
// the `outputSchema` a run asks for (an eval case or `runs.start`), not part of the agent.
export default defineAgent({
  name: 'terms',
  instructions: { file: './terms.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  // An entry whose input is Word, Excel or PDF also grants builtinSkill('office-reader'); each read
  // then waits for approval too, since it runs through run_skill_script.
  skills: [builtinSkill('office-writer'), skill('terms')],
  files: [files('terms', 'read')],
  limits: { maxTurns: 20, maxBudgetUsd: 0.5 },
});
