import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// Action (AC): it reads the staff list, the exported free/busy schedule and the meeting rules in its
// reference folder with the built-in `search_files` and the events already on the calendar with
// `list_events`, proposes a slot, and puts the event on the calendar with `create_event` (a
// calendar record, ADR-0169), which always waits for a person's approval; one approval covers one
// call (ADR-0145 D2.1). It sends no invitation. The connector is named after the entry, so two
// entries never share a demo stand-in. The typed proposal is the `outputSchema` a run asks for.
export default defineAgent({
  name: 'scheduling',
  instructions: { file: './scheduling.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__scheduling-calendar__list_events'],
    requireApproval: ['mcp__scheduling-calendar__create_event'],
  },
  permissions: { readFiles: true },
  tools: [mcp('scheduling-calendar')],
  skills: [skill('scheduling')],
  files: [files('scheduling', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
