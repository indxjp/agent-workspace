import { AW_CONTROL_SERVER, BUILDER_TOOLS } from '@indx-workspace/contracts/builder';
import { expect, it } from 'vitest';

it('resolves @indx-workspace/contracts/builder in packages/aw', () => {
  expect(AW_CONTROL_SERVER).toBe('aw-control');
  expect(Object.keys(BUILDER_TOOLS)).toContain('draft_check');
});
