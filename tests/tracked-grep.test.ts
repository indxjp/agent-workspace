import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { trackedFilesMatching } from './tracked-grep.js';

describe('trackedFilesMatching', () => {
  it('lists the tracked files a literal occurs in', () => {
    expect(trackedFilesMatching(['-lF', 'trackedFilesMatching', '--', 'tests'])).toContain(
      'tests/tracked-grep.ts',
    );
  });

  it('answers an empty list when nothing matches, so a gate fails on its own assertion', () => {
    // Built at runtime, so no tracked file can contain it.
    const absent = `absent-${randomBytes(16).toString('hex')}`;
    expect(trackedFilesMatching(['-lF', absent, '--', 'tests'])).toEqual([]);
  });

  it('still throws when git grep itself fails', () => {
    expect(() => trackedFilesMatching(['--no-such-option'])).toThrow();
  });
});
