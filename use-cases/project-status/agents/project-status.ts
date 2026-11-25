import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Started on a schedule by the trigger in `triggers/project-status.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads its own folder, `project-status`, and writes its report under its own
// `project-status-reports`, so two entries never share a folder and the records stay read-only.
export default defineAgent({
  name: 'project-status',
  instructions: { file: './project-status.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  skills: [skill('project-status')],
  files: [files('project-status', 'read'), files('project-status-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
