import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'contract-review',
  instructions: { file: './contract-review.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the skill script's call on an approval prompt.
  // The one thing legal decides is the redline: the agent saves it with `Write`, and the run waits
  // there for an approval (ADR-0145) before the Word file is made. Every other file is written by a
  // script, so that `Write` is the run's only gated call.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__run_skill_script', 'mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  // office-reader turns the draft into paragraphs JSON in `drafts` (the one read-write scratch
  // grant); contract-playbook checks that JSON, and once legal approves the redline, office-reader
  // writes the redlined copy to `outputs/` (the folder the run collects; the backend reads it back
  // with `runs.outputs`). It reaches no network. `runCommands` is what offers `run_skill_script`.
  // A question about a playbook rule is answered with the platform's `search_files` over the granted
  // `playbook` folder: no index and no connector of ours.
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  // Pinned to revision 1 of the playbook (`aw skills publish`): each review's run names this
  // version, and the version names the rules that applied, so a later edit cannot change the answer.
  skills: [builtinSkill('office-reader'), skill('contract-playbook', { revision: 1 })],
  files: [files('contracts', 'read'), files('playbook', 'read'), files('drafts', 'read-write')],
  limits: { maxTurns: 20, maxBudgetUsd: 1 },
});
