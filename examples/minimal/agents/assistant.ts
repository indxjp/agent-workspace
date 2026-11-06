import { defineAgent, skill } from '@indx-workspace/sdk/define';

// To let the agent read files you upload on the Files screen, add `files` to the import
// above and grant a folder:
//   permissions: { readFiles: true },
//   files: [files('uploads')],
// The folder must exist in the workspace first, or `aw dev` reports it as missing.
export default defineAgent({
  name: 'assistant',
  instructions: 'You are a customer support assistant. Answer questions clearly and briefly, ask for the details you need, and say so when you are not sure or when a person should take over.',
  engine: 'claude-agent-sdk',
  model: 'default',
  skills: [
    skill('refund-policy'),
  ],
});
