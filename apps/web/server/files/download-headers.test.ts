import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../../../tests/inventory-support';

import { toResponse } from './http';

const SETS_DISPOSITION = /['"]content-disposition['"]\s*[:,]/iu;
const SETS_NOSNIFF = /['"]x-content-type-options['"]\s*[:,]\s*['"]nosniff['"]/iu;
/** How many lines either side of a disposition its `nosniff` must sit: the same headers literal. */
const HEADER_WINDOW = 3;

describe('stored bytes are never served as a page from the app origin (the storage design, §05)', () => {
  // @story US-STO-05
  it('[US-STO-05][api][sdk] every stored-bytes response is an attachment with nosniff', () => {
    const files = execFileSync(
      'git',
      ['grep', '-l', '-i', 'content-disposition', '--', 'apps/web/server', ':(exclude)*.test.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter((file) => file !== '');

    expect(files).toEqual(
      expect.arrayContaining([
        'apps/web/server/files/http.ts',
        'apps/web/server/platforms/http.ts',
      ]),
    );
    // ponytail: source-level line window, not an AST; tighten if a handler sets headers indirectly.
    for (const file of files) {
      const lines = readFileSync(`${REPO_ROOT}/${file}`, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!SETS_DISPOSITION.test(line)) return;
        const nearby = lines.slice(Math.max(0, index - HEADER_WINDOW), index + HEADER_WINDOW + 1);
        expect(
          nearby.some((candidate) => SETS_NOSNIFF.test(candidate)),
          `${file}:${index + 1} sets content-disposition without an x-content-type-options: nosniff beside it`,
        ).toBe(true);
      });
    }

    const response = toResponse({
      kind: 'binary',
      status: 200,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
      filename: 'q3.pdf',
    });
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/u);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
