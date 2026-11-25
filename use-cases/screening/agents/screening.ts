import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

import publicLists from '../tools/lists.ts';

// It reads the registration request in `screening/inbox` and the procedure in `screening/standards`,
// checks each name against the public lists with `check_public_lists` (a read-only code tool, served
// through the shared `aw-dev-tools` connector, ADR-0170), and writes the report to
// `screening-reports` with `Write`, which waits for a person. Only the reads run unasked; a skill
// script may write wherever the agent may, so `run_skill_script` waits too (ADR-0167 D5, #2388).
export default defineAgent({
  name: 'screening',
  instructions: { file: './screening.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__check_public_lists'],
    requireApproval: ['Write', 'mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  tools: [publicLists],
  skills: [builtinSkill('office-reader'), skill('screening')],
  files: [files('screening', 'read'), files('screening-reports', 'read-write')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
