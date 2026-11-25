import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import notices from '../tools/notices.ts';

// Started on a schedule by the trigger in `triggers/reg-watch.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads the public notices through `read_reg_notices` (a dated
// snapshot in the demo, ADR-0170) and the watch list in its own folder, `reg-watch`, and writes its
// report under its own `reg-watch-reports`, so the watch list stays read-only.
export default defineAgent({
  name: 'reg-watch',
  instructions: { file: './reg-watch.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__read_reg_notices'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  tools: [notices],
  skills: [skill('reg-watch')],
  files: [files('reg-watch', 'read'), files('reg-watch-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
