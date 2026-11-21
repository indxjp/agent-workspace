import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// Action (AC): it reads its reference folder with the built-in `search_files` and the system's open
// records with `list_tasks`, proposes the change, and makes it with `create_task`, which always
// waits for a person's approval; one approval covers one call (ADR-0145 D2.1), so each record is
// its own call. The connector is named after the entry, so two entries never share a demo stand-in.
// The typed proposal is the `outputSchema` a run asks for (an eval case or `runs.start`).
// Another record kind (calendar, access, booking) edits the tool names here and the `kind` in
// the entry's `CONNECTOR_TOOLS` row (tests/store/seed/build.ts).
export default defineAgent({
  name: '__slug__',
  instructions: { file: './__slug__.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp____slug__-tasks__list_tasks'],
    requireApproval: ['mcp____slug__-tasks__create_task'],
  },
  permissions: { readFiles: true },
  tools: [mcp('__slug__-tasks')],
  skills: [skill('__slug__')],
  files: [files('__slug__', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
