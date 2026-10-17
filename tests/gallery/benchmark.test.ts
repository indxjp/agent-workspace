/**
 * The gallery's bookkeeping: every verdict has evidence that exists, and every tutorial shows the
 * verdicts its benchmark declares.
 *
 * The tutorials' status tables are rendered from `<use case>/benchmark.ts` between the markers
 * `{/* benchmark:start *\/}` and `{/* benchmark:end *\/}`. A hand edit that disagrees with the
 * benchmark fails here; `GALLERY_WRITE=1 pnpm vitest run --project tests tests/gallery` rewrites
 * them from the benchmarks.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAPABILITIES, renderOverviewTable, renderStandingTable } from './harness/benchmark.ts';
import { PROBES } from './harness/probes.ts';
import { GALLERY_DIR, loadUseCases, REPOSITORY_ROOT, TUTORIALS_DIR } from './harness/registry.ts';

const START = '{/* benchmark:start */}';
const END = '{/* benchmark:end */}';
const WRITE = process.env['GALLERY_WRITE'] === '1';

const useCases = loadUseCases();

/** Replace the text between the markers in `file` with `content`, or check that it is there. */
async function generated(file: string, content: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  expect(start, `${file} has no ${START} marker`).toBeGreaterThanOrEqual(0);
  expect(end, `${file} has no ${END} marker after ${START}`).toBeGreaterThan(start);
  const expected = `${text.slice(0, start + START.length)}\n\n${content}\n\n${text.slice(end)}`;
  if (WRITE) {
    await writeFile(file, expected);
    return;
  }
  expect(text, `${path.relative(REPOSITORY_ROOT, file)} is stale; run with GALLERY_WRITE=1`).toBe(
    expected,
  );
}

function sourcePaths(ref: string): string[] {
  return ref
    .split(';')
    .map((part) => part.trim().split(/\s/u)[0] ?? '')
    .filter((part) => part !== '');
}

describe('gallery benchmarks', () => {
  it('has ten use cases numbered 1 to 10', () => {
    expect(useCases.map(({ benchmark }) => benchmark.order)).toStrictEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('registers every use-case directory, and only those', async () => {
    const entries = await readdir(GALLERY_DIR, { withFileTypes: true });
    // A use case is a directory holding a project file (harness/ and shared/ hold none).
    const withBenchmark = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(path.join(GALLERY_DIR, entry.name, 'agent-workspace.yaml')),
      )
      .map((entry) => entry.name)
      .sort();
    expect(useCases.map(({ benchmark }) => benchmark.id).sort()).toStrictEqual(withBenchmark);
  });

  describe.each(useCases.map((useCase) => [useCase.benchmark.id, useCase] as const))(
    '%s',
    (id, useCase) => {
      it('names evidence that exists for every verdict', async () => {
        const testSource = await readFile(path.join(useCase.dir, `${id}.test.ts`), 'utf8');
        const evalSources = await Promise.all(
          useCase.benchmark.cells.eval === null
            ? []
            : [readFile(path.join(useCase.dir, 'evals', `${id}.yaml`), 'utf8').catch(() => '')],
        );
        for (const capability of CAPABILITIES) {
          const cell = useCase.benchmark.cells[capability];
          if (cell === null) continue;
          const where = `${id}.${capability}`;
          // The note is rendered into MDX, where a bare < or { starts JSX; inside `code` it is text.
          expect(
            cell.note.replace(/`[^`]*`/gu, ''),
            `${where}: put < > { } in backticks`,
          ).not.toMatch(/[<>{}]/u);
          if (cell.evidence === 'contract') {
            expect(testSource, `${where}: no test titled "${cell.ref}"`).toContain(`'${cell.ref}'`);
          } else if (cell.evidence === 'probe') {
            expect(Object.keys(PROBES), `${where}: no probe "${cell.ref}"`).toContain(cell.ref);
          } else if (cell.evidence === 'source') {
            for (const file of sourcePaths(cell.ref)) {
              expect(
                existsSync(path.join(REPOSITORY_ROOT, file)),
                `${where}: ${file} does not exist`,
              ).toBe(true);
            }
          } else {
            expect(evalSources.join('\n'), `${where}: no eval case "${cell.ref}"`).toContain(
              cell.ref,
            );
          }
        }
      });

      it('its tutorial shows the benchmark', async () => {
        await generated(
          path.join(TUTORIALS_DIR, `${id}.mdx`),
          renderStandingTable(useCase.benchmark),
        );
      });
    },
  );

  it('the gallery overview shows every benchmark', async () => {
    await generated(
      path.join(TUTORIALS_DIR, 'index.mdx'),
      renderOverviewTable(useCases.map(({ benchmark }) => benchmark)),
    );
  });
});
