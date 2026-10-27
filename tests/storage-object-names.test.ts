// Fitness test (the storage design, §05 "One workspace reads another's files"): only
// `object-name.ts` builds a `workspaces/<id>/…` object name. `object-store.ts` stays allowed while
// `workspaceKeyPrefix` serves legacy reads (the #1699 bridge marker in that file).
import { describe, expect, it } from 'vitest';

import { trackedTextFiles } from '../scripts/ci/debt-review.mjs';

const TEMPLATE_NAME = '`workspaces/${';
const ALLOWED = new Set([
  'packages/core/src/storage/object-name.ts',
  'packages/core/src/storage/object-store.ts',
]);

function violations(files: readonly { path: string; text: string }[]): string[] {
  return files
    .filter(
      ({ path, text }) =>
        /^(?:apps|packages)\/.*\.ts$/u.test(path) &&
        !/\.(?:test|spec)\.ts$/u.test(path) &&
        !ALLOWED.has(path) &&
        text.includes(TEMPLATE_NAME),
    )
    .map(({ path }) => path);
}

describe('storage object names', () => {
  it('only object-name.ts builds workspace object names', () => {
    const planted = { path: 'apps/web/server/x.ts', text: `const k = ${TEMPLATE_NAME}id}/a\`;` };
    expect(violations([planted])).toEqual(['apps/web/server/x.ts']);
    expect(violations([{ ...planted, path: 'apps/web/server/x.test.ts' }])).toEqual([]);
    expect(violations([{ ...planted, path: 'packages/core/src/storage/object-name.ts' }])).toEqual(
      [],
    );
    expect(violations(trackedTextFiles())).toEqual([]);
  });
});
