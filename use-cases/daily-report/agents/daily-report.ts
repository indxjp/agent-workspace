import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Started on a schedule by the trigger in `triggers/daily-report.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads its own folder, `daily-report`, and writes its report under its own
// `daily-report-reports`, so two entries never share a folder and the records stay read-only.
export default defineAgent({
  name: 'daily-report',
  instructions: { file: './daily-report.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  skills: [skill('daily-report')],
  files: [files('daily-report', 'read'), files('daily-report-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
