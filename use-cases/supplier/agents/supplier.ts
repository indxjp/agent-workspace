import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Started on a schedule by the trigger in `triggers/supplier.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads its own folder, `supplier`, and writes its report under its own
// `supplier-reports`, so two entries never share a folder and the records stay read-only.
export default defineAgent({
  name: 'supplier',
  instructions: { file: './supplier.md' },
  model: 'default',
  // Reading is unattended; the report's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  skills: [skill('supplier')],
  files: [files('supplier', 'read'), files('supplier-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
