import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Started on a schedule by the trigger in `triggers/voc.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads its own folder, `voc`, and writes its report under its own
// `voc-reports`, so two entries never share a folder and the records stay read-only.
export default defineAgent({
  name: 'voc',
  instructions: { file: './voc.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  skills: [skill('voc')],
  files: [files('voc', 'read'), files('voc-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
