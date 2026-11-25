import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import news from '../tools/news.ts';

// Started on a schedule by the trigger in `triggers/trend.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads public news and posts through `read_public_news` (a dated snapshot
// in the demo, ADR-0170) and the topic list in its own folder, `trend`, and writes its digest under
// its own `trend-reports`, so the topic list stays read-only.
export default defineAgent({
  name: 'trend',
  instructions: { file: './trend.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__read_public_news'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  tools: [news],
  skills: [skill('trend')],
  files: [files('trend', 'read'), files('trend-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
