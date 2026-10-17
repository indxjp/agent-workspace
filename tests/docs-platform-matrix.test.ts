import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  matrixTable,
  PLATFORM_MATRIX_PAGE,
  PLATFORM_MATRIX_SOURCE,
  withMatrixRegion,
} from '../scripts/docs/sync-platform-matrix.mjs';

const repository = new URL('../', import.meta.url);
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

describe('docs/sdk/site/platforms/matrix.mdx', () => {
  it('carries the table of docs/platform-matrix.md and nothing else between its markers', async () => {
    const source = await readFile(new URL(PLATFORM_MATRIX_SOURCE, repository), 'utf8');
    const page = await readFile(new URL(PLATFORM_MATRIX_PAGE, repository), 'utf8');
    expect(
      withMatrixRegion(page, matrixTable(source)),
      'run `node scripts/docs/sync-platform-matrix.mjs --write`',
    ).toBe(page);
  });

  it('has a guide for every platform in the matrix header', async () => {
    const source = await readFile(new URL(PLATFORM_MATRIX_SOURCE, repository), 'utf8');
    const header = matrixTable(source).split('\n')[0] ?? '';
    const ids = header
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '' && cell !== 'Capability');
    expect(ids.length).toBeGreaterThan(0);
    const eject = await readFile(new URL('docs/sdk/site/platforms/eject.mdx', repository), 'utf8');
    for (const id of ids) {
      if (id.startsWith('eject-')) {
        expect(eject, `platforms/eject.mdx names ${id}`).toContain(id);
      } else {
        await expect(
          access(new URL(`docs/sdk/site/platforms/${id}.mdx`, repository)),
          `docs/sdk/site/platforms/${id}.mdx`,
        ).resolves.toBeUndefined();
      }
    }
  });
});
