import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

import { workflow } from '../tools/workflow.ts';

export default defineAgent({
  name: 'ringi-review',
  instructions: { file: './ringi-review.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the file search on an approval prompt.
  engine: { id: 'claude-agent-sdk', autoApprove: ['mcp__agent-workspace__search_files'] },
  // It reads the rules and the archive, and its one write is a comment on the ringi (postComment,
  // which waits for approval). It cannot approve or reject a ringi because no tool it holds can,
  // and the project's policy ceiling forbids writing files, running commands and open network
  // access for every agent in the project. The rules and the past ringi are found with the
  // built-in `search_files`; the backend narrows a run to the departments' folders the filer may
  // read (`runs.start({ fileScope })`).
  permissions: { readFiles: true },
  tools: [mcp('authority'), workflow],
  skills: [skill('ringi-checklist')],
  files: [files('rules', 'read'), files('ringi', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
