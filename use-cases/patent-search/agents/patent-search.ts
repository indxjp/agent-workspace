import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import patents from '../tools/patents.ts';

// Grounded answers (QA), read-only: the patent publications through `search_patents` (a dated
// snapshot in the demo, ADR-0170) and the technical memo in `patent-search` through `search_files`,
// both read unasked. It cites every publication with its number and date, and writes nothing.
export default defineAgent({
  name: 'patent-search',
  instructions: { file: './patent-search.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__search_patents'],
  },
  permissions: { readFiles: true },
  tools: [patents],
  skills: [skill('patent-search')],
  files: [files('patent-search', 'read')],
  limits: { maxTurns: 14, maxBudgetUsd: 0.5 },
});
