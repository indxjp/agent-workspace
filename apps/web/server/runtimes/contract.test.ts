import { describe, expect, it } from 'vitest';

import { relativeRuntimePath } from './contract';

describe('relativeRuntimePath', () => {
  it('strips the runner workspace root, with or without a trailing slash', () => {
    expect(relativeRuntimePath('/workspace/out')).toBe('out');
    expect(relativeRuntimePath('/workspace/out/report.md')).toBe('out/report.md');
    expect(relativeRuntimePath('\\workspace\\out')).toBe('out');
    expect(relativeRuntimePath('out')).toBe('out');
  });

  it('refuses the workspace root itself', () => {
    expect(() => relativeRuntimePath('/workspace')).toThrow(/is not workspace-relative/u);
    expect(() => relativeRuntimePath('/workspace/')).toThrow(/is not workspace-relative/u);
  });

  it('strips only a whole /workspace segment, so a sibling directory stays absolute and is refused', () => {
    expect(() => relativeRuntimePath('/workspaces/out')).toThrow(/is not workspace-relative/u);
    expect(() => relativeRuntimePath('/workspace-old/out')).toThrow(/is not workspace-relative/u);
  });
});
