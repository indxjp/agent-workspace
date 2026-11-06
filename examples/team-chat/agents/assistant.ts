import { defineAgent } from '@indx-workspace/sdk/define';

// To let the agent read files you upload on the Files screen, add `files` to the import
// above and grant a folder:
//   permissions: { readFiles: true },
//   files: [files('uploads')],
// The folder must exist in the workspace first, or `aw dev` reports it as missing.
export default defineAgent({
  name: 'assistant',
  instructions: 'You are a helpful assistant. Answer clearly and briefly, and say so when you are not sure.',
  engine: 'claude-agent-sdk',
  model: 'default',
});
