/**
 * `docs/platform-matrix.md` is generated, and this is the gate that says so (ADR-0133, #956).
 *
 * The renderer imports the packages' TypeScript directly, so the comparison runs under vitest
 * rather than under plain node, which is also why the writer and `--check` mode
 * (`tests/platform-matrix/run.mjs`, wired into `pnpm docs:generate` and `pnpm docs:check`) spawn
 * vitest on this file. One renderer, one comparison, and no second transcription of the table.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PLATFORM_IDS } from '@indx-workspace/contracts/platforms';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';
import { describe, expect, it } from 'vitest';

import { PLATFORM_MATRIX_COLUMNS, renderPlatformMatrix } from './platform-matrix/renderer.js';

const OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/platform-matrix.md',
);

describe('docs/platform-matrix.md', () => {
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
