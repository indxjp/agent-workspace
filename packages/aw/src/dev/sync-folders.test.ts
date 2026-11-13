import { describe, expect, it } from 'vitest';

import { tempFile } from '../testing.js';

import { start, synced, until } from './sync.fixture.test-support.js';
describe('startDevSync over a file folder with no file (#899)', () => {
  const GRANTED = `import { defineAgent, files } from '@indx-workspace/sdk/define';
export default defineAgent({ name: 'reviewer', instructions: 'R.', files: [files('playbook', 'read')] });
`;

  it('says what to run, since no edit to the file creates the folder', async () => {
    const harness = await start({ 'agents/reviewer.ts': GRANTED });
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output()).toEqual({
      stdout:
        'agents/reviewer.ts: 422 agent_definition_references_missing [file:playbook]; upload a file into playbook (aw files upload <folder>/<name> <local-file>), then save again or run aw push --yes\n',
      stderr:
        'sync: 1 problem; upload the files named above, then save a file or run aw push --yes to sync again\n',
    });
    expect(harness.fatal).toEqual([]);
  });

  it('syncs the agent once a file is in the folder and the project is saved again', async () => {
    const harness = await start({ 'agents/reviewer.ts': GRANTED });
    await until(harness, () => harness.output().stderr.includes('sync: '));
    harness.state.folders.add('playbook');
    await tempFile(harness.root, 'agents/reviewer.ts', `${GRANTED}\n`);
    await until(harness, () => synced(harness) === 1);
  });
});
