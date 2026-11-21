import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

// The kit's fixture use case (use-cases/kit/describe-use-case.test.ts): the smallest project that
// passes the contract, moment and flow tiers.
export default defineAgent({
  name: 'fixture-qa',
  instructions: { file: './fixture-qa.md' },
  model: 'default',
  engine: { id: 'claude-agent-sdk', autoApprove: ['mcp__agent-workspace__search_files'] },
  permissions: { readFiles: true, runCommands: true },
  skills: [skill('tally')],
  files: [files('fixture-qa', 'read')],
  limits: { maxTurns: 4 },
});
