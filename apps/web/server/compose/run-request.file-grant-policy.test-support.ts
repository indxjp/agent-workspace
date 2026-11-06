import { describe, expect, it } from 'vitest';

import { applyFileGrantPolicy } from './run-request';
import { EMPTY_SHA256 } from './run-request.fixture.test-support';
export function registerFileGrantPolicyTests() {
  describe('applyFileGrantPolicy — the compose-side legacy guard (ENG-04b, #325)', () => {
    it('answers the read-only-grant denials, in the order the adapter also derives them', () => {
      expect(
        applyFileGrantPolicy('/workspace/w/s', [
          { kind: 'file', path: 'secret.txt', access: 'read', size: 0, sha256: EMPTY_SHA256 },
          { kind: 'directory', path: 'archive', access: 'read' },
          { kind: 'file', path: 'draft.txt', access: 'read-write', size: 0, sha256: EMPTY_SHA256 },
        ]),
      ).toEqual([
        'Edit(//workspace/w/s/secret.txt)',
        'Edit(//workspace/w/s/archive/**)',
        'Bash',
        'BashOutput',
        'KillShell',
      ]);
    });

    it('answers nothing when no grant is read-only, so a run without one is unnarrowed', () => {
      expect(applyFileGrantPolicy('/workspace/w/s', [])).toEqual([]);
      expect(
        applyFileGrantPolicy('/workspace/w/s', [
          { kind: 'file', path: 'draft.txt', access: 'read-write', size: 0, sha256: EMPTY_SHA256 },
        ]),
      ).toEqual([]);
    });
  });
}
