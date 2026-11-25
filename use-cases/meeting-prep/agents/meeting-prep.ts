import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Started on a schedule by the trigger in `triggers/meeting-prep.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads its own folder, `meeting-prep`, and writes its report under its own
// `meeting-prep-reports`, so two entries never share a folder and the records stay read-only.
export default defineAgent({
  name: 'meeting-prep',
  instructions: { file: './meeting-prep.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  skills: [skill('meeting-prep')],
  files: [files('meeting-prep', 'read'), files('meeting-prep-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
