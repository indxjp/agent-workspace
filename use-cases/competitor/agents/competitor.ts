import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import releases from '../tools/releases.ts';

// Started on a schedule by the trigger in `triggers/competitor.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads the competitors' public releases through `read_competitor_news`
// (a dated snapshot in the demo, ADR-0170) and the comparison table in its own folder, `competitor`,
// and writes its report under its own `competitor-reports`, so the table stays read-only.
export default defineAgent({
  name: 'competitor',
  instructions: { file: './competitor.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__read_competitor_news'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  tools: [releases],
  skills: [skill('competitor')],
  files: [files('competitor', 'read'), files('competitor-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
