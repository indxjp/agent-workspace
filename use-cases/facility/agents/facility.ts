import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// Action (AC): it reads the resources, the booking rules, the exported bookings and the driver list
// in its reference folder with the built-in `search_files` and the bookings made in chat with
// `list_bookings`, proposes the booking, and makes it with `book_resource` (a booking record,
// ADR-0169), which always waits for a person's approval; one approval covers one call (ADR-0145
// D2.1), so each booking is its own call. The connector is named after the entry, so two entries
// never share a demo stand-in. The typed proposal is the `outputSchema` a run asks for.
export default defineAgent({
  name: 'facility',
  instructions: { file: './facility.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__facility-bookings__list_bookings'],
    requireApproval: ['mcp__facility-bookings__book_resource'],
  },
  permissions: { readFiles: true },
  tools: [mcp('facility-bookings')],
  skills: [skill('facility')],
  files: [files('facility', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 0.5 },
});
