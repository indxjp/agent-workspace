/**
 * `docs/engine-matrix.md` is generated, and this is the gate that says so (ENG-04, #303).
 *
 * The renderer imports the packages' TypeScript directly, so the comparison runs under vitest
 * rather than under plain node — which is also why the *writer*
 * (`tests/engine-matrix/run.mjs`, wired into `pnpm docs:generate`) spawns vitest with
 * `ENGINE_MATRIX_WRITE=1` instead of rendering the file itself. One renderer, two entry points,
 * and no second transcription of the table.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENGINE_MATRIX_COLUMNS, renderEngineMatrix } from './engine-matrix/renderer.js';

const OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/engine-matrix.md',
);

describe('docs/engine-matrix.md', () => {
  it('matches what the adapters declare and the conformance kit observes', async () => {
    const rendered = await renderEngineMatrix();
    if (process.env['ENGINE_MATRIX_WRITE'] === '1') {
      // Under CI this test is a staleness gate; a write there would pass without checking.
      if (process.env['CI']) throw new Error('ENGINE_MATRIX_WRITE=1 is refused under CI');
      writeFileSync(OUTPUT, rendered);
      return;
    }
    expect(readFileSync(OUTPUT, 'utf8'), 'run `node tests/engine-matrix/run.mjs`').toBe(rendered);
  });

  it('has a column for every adapter this repository ships', () => {
    // ADR-0015: a matrix rendered from an empty column list would match an empty file and prove
    // nothing. The `claude-agent-sdk` column is named because the acceptance criterion names it.
    expect(ENGINE_MATRIX_COLUMNS.length).toBeGreaterThan(0);
    expect(ENGINE_MATRIX_COLUMNS.map((column) => column.id)).toContain('claude-agent-sdk');
    expect(ENGINE_MATRIX_COLUMNS.map((column) => column.id)).toContain('openai-agents');
    expect(ENGINE_MATRIX_COLUMNS.map((column) => column.id)).toContain('pi');
    expect(ENGINE_MATRIX_COLUMNS.map((column) => column.id)).toContain('mastra');
  });
});
