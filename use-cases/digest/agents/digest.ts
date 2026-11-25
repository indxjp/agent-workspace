import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import publicSources from '../tools/sources.ts';

// Started on a schedule by the trigger in `triggers/digest.json`, which asks for the typed report
// (ADR-0144, ADR-0154). It reads its own folder, `digest`, and the public releases through
// `read_digest_sources` (a read-only code tool on the shared `aw-dev-tools` connector, ADR-0170),
// and writes its digest under its own `digest-reports`.
export default defineAgent({
  name: 'digest',
  instructions: { file: './digest.md' },
  model: 'default',
  // Reading is unattended; the digest's one write waits for the owner's approval (ADR-0145).
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__read_digest_sources'],
    requireApproval: ['Write'],
  },
  permissions: { readFiles: true, writeFiles: true },
  tools: [publicSources],
  skills: [skill('digest')],
  files: [files('digest', 'read'), files('digest-reports', 'read-write')],
  limits: { maxTurns: 30 },
});
