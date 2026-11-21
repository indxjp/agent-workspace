import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// Action (AC): it reads the access policy, the HR records and the current access in its reference
// folder with the built-in `search_files` and the changes already made with `list_grants`, proposes
// the change, and makes it with `change_access` (an access record, ADR-0169), which always waits for
// a person's approval; one approval covers one call (ADR-0145 D2.1), so each grant is its own call.
// The connector is named after the entry, so two entries never share a demo stand-in. The typed
// proposal is the `outputSchema` a run asks for (an eval case or `runs.start`).
export default defineAgent({
  name: 'account-requests',
  instructions: { file: './account-requests.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: [
      'mcp__agent-workspace__search_files',
      'mcp__account-requests-grants__list_grants',
    ],
    requireApproval: ['mcp__account-requests-grants__change_access'],
  },
  permissions: { readFiles: true },
  tools: [mcp('account-requests-grants')],
  skills: [skill('account-requests')],
  files: [files('account-requests', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
