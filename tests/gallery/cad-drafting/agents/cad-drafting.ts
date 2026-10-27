import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'cad-drafting',
  instructions: { file: './cad-drafting.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval prompt.
  // The one thing a designer decides is the change set: the agent saves it with `Write`, and the run
  // waits there for an approval (ADR-0145) before it drafts. The base drawing is saved by the
  // office-reader script (`dxf.mjs <file> <out.json>`), so that `Write` is the run's only gated call.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__run_skill_script', 'mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  // Similar drawings are found with the platform's `search_files`, which the backend narrows to the
  // designer's drawing series with `runs.start({ fileScope })`: no index server of ours.
  // It runs the skill's script to write a draft, so it needs commands and file writes; the grants
  // below keep the writes to `drafts` (and `outputs/`, which a `writeFiles` agent may write): past drawings
  // are read-only.
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  // office-reader reads the base drawing; dxf-draft only derives and writes the draft.
  skills: [builtinSkill('office-reader'), skill('dxf-draft')],
  files: [files('drawings', 'read'), files('drafts', 'read-write')],
  limits: { maxTurns: 20, maxBudgetUsd: 1 },
});
