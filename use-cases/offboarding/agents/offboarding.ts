import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// Action (AC): it reads the offboarding checklist, the HR records, the items lent and the current
// access in its reference folder with the built-in `search_files` and the removals already made with
// `list_grants`, proposes the steps, and records each access removal with `change_access` (an access
// record, ADR-0169), which always waits for a person's approval; one approval covers one call
// (ADR-0145 D2.1), so each removal is its own call. It has no tool that deletes an account or data.
// The connector is named after the entry, so two entries never share a demo stand-in.
export default defineAgent({
  name: 'offboarding',
  instructions: { file: './offboarding.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__offboarding-access__list_grants'],
    requireApproval: ['mcp__offboarding-access__change_access'],
  },
  permissions: { readFiles: true },
  tools: [mcp('offboarding-access')],
  skills: [skill('offboarding')],
  files: [files('offboarding', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
