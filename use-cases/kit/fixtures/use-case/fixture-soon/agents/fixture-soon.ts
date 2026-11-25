import { defineAgent, files } from '@indx-workspace/sdk/define';

// The kit's coming-soon fixture: no code beyond its definition, so it lists no flow.
export default defineAgent({
  name: 'fixture-soon',
  instructions: { file: './fixture-soon.md' },
  model: 'default',
  engine: { id: 'claude-agent-sdk', autoApprove: ['mcp__agent-workspace__search_files'] },
  permissions: { readFiles: true },
  files: [files('fixture-soon', 'read')],
});
