/**
 * `docs/30-reference/matrices/platform-matrix.md` is generated, and this is the gate that says so (ADR-0133, #956).
 *
 * The renderer imports the packages' TypeScript directly, so the comparison runs under vitest
 * rather than under plain node: it is a static check of the `docs-check` lane
 * (tests/static-checks/vitest.config.ts), which `pnpm docs:check` runs, and the writer
 * (`tests/platform-matrix/run.mjs`, in `pnpm docs:generate`) runs this file with
 * `PLATFORM_MATRIX_WRITE=1`. One renderer, one comparison, and no second transcription of the
 * table. No test lane runs it again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PLATFORM_IDS } from '@indx-workspace/contracts/platforms';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';
import { describe, expect, it } from 'vitest';

import { matrixTable, PLATFORM_MATRIX_SOURCE } from '../../scripts/docs/sync-platform-matrix.mjs';
import { PLATFORM_MATRIX_COLUMNS, renderPlatformMatrix } from './renderer.js';

const repository = new URL('../../', import.meta.url);

const OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../docs/30-reference/matrices/platform-matrix.md',
);

describe('docs/30-reference/matrices/platform-matrix.md', () => {
  it('matches what the targets declare and the conformance kit observes', () => {
    const rendered = renderPlatformMatrix();
    if (process.env['PLATFORM_MATRIX_WRITE'] === '1') {
      writeFileSync(OUTPUT, rendered);
      return;
    }
    expect(readFileSync(OUTPUT, 'utf8'), 'run `node tests/platform-matrix/run.mjs`').toBe(rendered);
  });

  it('has a column for every registered target, and each is a platform id', () => {
    // ADR-0015: a matrix rendered from an empty column list would match an empty file and prove
    // nothing.
    expect(PLATFORM_MATRIX_COLUMNS.length).toBeGreaterThan(0);
    expect(PLATFORM_MATRIX_COLUMNS.map((target) => target.id)).toEqual(
      PLATFORM_TARGETS.map((target) => target.id),
    );
    for (const target of PLATFORM_MATRIX_COLUMNS) expect(PLATFORM_IDS).toContain(target.id);
  });

  it('has no failing conformance cell', () => {
    expect(renderPlatformMatrix()).not.toContain('✗');
  });
});

describe('docs/sdk/site/platforms/matrix.mdx', () => {
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
