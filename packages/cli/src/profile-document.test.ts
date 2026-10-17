import { describe, expect, it } from 'vitest';

import {
  ProjectFileError,
  readProjectFileText,
  writeProjectFileText,
} from '@indx-workspace/sdk/project';

import {
  readProfileDocumentText,
  serializeProfileDocument,
  ProfileDocumentError,
} from './profile-document.js';

// The reader's refusals and the writer's quoting are tested where they live, in
// `@indx-workspace/sdk/project`; these are the guarantees the CLI's own names keep.
describe('the deployment profile document', () => {
  it('is the SDK reader and writer under the CLI names', () => {
    expect(readProfileDocumentText).toBe(readProjectFileText);
    expect(serializeProfileDocument).toBe(writeProjectFileText);
    expect(ProfileDocumentError).toBe(ProjectFileError);
  });

  it('refuses an anchor with a ProfileDocumentError naming its line and column', () => {
    let refused: unknown;
    try {
      readProfileDocumentText('cloud: local\nstorage: &shared\n  objects: x\n');
    } catch (thrown) {
      refused = thrown;
    }
    if (!(refused instanceof ProfileDocumentError)) throw new Error('expected a refusal');
    expect({ line: refused.line, column: refused.column }).toEqual({ line: 2, column: 10 });
    expect(refused.message).toMatch(/^agent-workspace\.yaml line 2, column 10: an anchor/u);
  });

  it('writes a two-level profile byte for byte as before', () => {
    expect(serializeProfileDocument({ cloud: 'gcp', storage: { secrets: 'yes' } })).toBe(
      'cloud: gcp\nstorage:\n  secrets: yes\n',
    );
  });
});
