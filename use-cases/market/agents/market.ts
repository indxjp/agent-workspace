import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import marketStats from '../tools/stats.ts';

// Grounded answers (QA), read-only: the public statistics through `read_market_stats` (a dated
// snapshot in the demo, ADR-0170) and the research memo in `market` through `search_files`, both
// read unasked. It cites every figure with its source and date, and writes nothing.
export default defineAgent({
  name: 'market',
  instructions: { file: './market.md' },
  model: 'default',
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__read_market_stats'],
  },
  permissions: { readFiles: true },
  tools: [marketStats],
  skills: [skill('market')],
  files: [files('market', 'read')],
  limits: { maxTurns: 12, maxBudgetUsd: 0.5 },
});
