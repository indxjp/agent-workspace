/**
 * The site matrix page's sync, on in-memory pages. `scripts/docs/sync-platform-matrix.mjs --check`
 * compares the real page with docs/30-reference/matrices/platform-matrix.md in `pnpm docs:check`,
 * and tests/platform-matrix/platform-matrix.docs-check.ts checks every platform has a guide.
 */
import { describe, expect, it } from 'vitest';

import { matrixTable, withMatrixRegion } from '../scripts/docs/sync-platform-matrix.mjs';

const START = '{/* platform-matrix:start */}';
const END = '{/* platform-matrix:end */}';

describe('matrixTable', () => {
  it('keeps only the | lines, in order', () => {
    const source = '# Title\n\ntext\n| a | b |\n| --- | --- |\nmore text\n| 1 | 2 |\n';
    expect(matrixTable(source)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('throws when the source has no table', () => {
    expect(() => matrixTable('# Title\n\nno table here\n')).toThrow(/no table/u);
  });
});

describe('withMatrixRegion', () => {
  const before = 'intro\n\n';
  const after = '\nlegend\n';

  it('replaces only the region and keeps the text around it byte-identical', () => {
    const page = `${before}${START}\n\n| old |\n\n${END}${after}`;
    expect(withMatrixRegion(page, '| new |')).toBe(
      `${before}${START}\n\n| new |\n\n${END}${after}`,
    );
  });

  it('names the missing marker', () => {
    expect(() => withMatrixRegion(`${before}${END}`, '| t |')).toThrow('platform-matrix:start');
    expect(() => withMatrixRegion(`${before}${START}`, '| t |')).toThrow('platform-matrix:end');
  });

  it('refuses an end marker that precedes the start', () => {
    expect(() => withMatrixRegion(`${END}\n${START}\n`, '| t |')).toThrow('platform-matrix:end');
  });
});
