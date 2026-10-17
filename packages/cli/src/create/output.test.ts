import { describe, expect, it } from 'vitest';

import { windowsDriveWarning } from './output.ts';

describe('windowsDriveWarning (BH061-034)', () => {
  it('warns about a project on a Windows drive under WSL', () => {
    expect(windowsDriveWarning('/mnt/c/Users/me/my-agent', true)).toContain(
      'create it under your Linux home (~/)',
    );
    expect(windowsDriveWarning('/mnt/d', true)).not.toBeNull();
  });

  it('says nothing on the Linux filesystem, for another mount, or outside WSL', () => {
    expect(windowsDriveWarning('/home/me/my-agent', true)).toBeNull();
    expect(windowsDriveWarning('/mnt/data/my-agent', true)).toBeNull();
    expect(windowsDriveWarning('/mnt/c/Users/me/my-agent', false)).toBeNull();
  });
});
