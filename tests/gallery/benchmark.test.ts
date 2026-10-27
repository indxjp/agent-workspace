/**
 * The gallery's bookkeeping: every verdict has evidence that exists, and every tutorial shows the
 * verdicts its benchmark declares.
 *
 * The tutorials' status tables are rendered from `<use case>/benchmark.ts` between the markers
 * `{/* benchmark:start *\/}` and `{/* benchmark:end *\/}`. A hand edit that disagrees with the
 * benchmark fails here; `GALLERY_WRITE=1 pnpm vitest run --project tests tests/gallery` rewrites
 * them from the benchmarks.
 *
 * The landing page's use-case scores sit between `<!-- benchmark:score <use case> -->` and
 * `<!-- benchmark:end -->` (`min` and `max` mark the published range); the same check and rewrite
 * apply to them.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  renderOverviewTable,
  renderStandingTable,
  scoreOf,
} from './harness/benchmark.ts';
import { PROBES } from './harness/probes.ts';
import { GALLERY_DIR, loadUseCases, REPOSITORY_ROOT, TUTORIALS_DIR } from './harness/registry.ts';

const START = '{/* benchmark:start */}';
const END = '{/* benchmark:end */}';
const WRITE = process.env['GALLERY_WRITE'] === '1';
const LANDING_PAGE = path.join(REPOSITORY_ROOT, 'sites', 'lp', 'use-cases.html');
const LANDING_SCORE = /<!-- benchmark:score ([a-z-]+) -->\d*<!-- benchmark:end -->/gu;

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

  it('no use case ships its own document reader', async () => {
    // Documents are read by the built-in office-reader skill: no unzip, no zip end-of-central-directory
    // signature, no DXF group-code pair reader in a use case's skill scripts or MCP servers.
    const readers = [/inflateRawSync/u, /0x06054b50/iu, /\b(?:pairsOf|parseDxf)\b/u];
    // `run_skill_script` starts one script and has no pipe, so excel-consolidate carries a copy of
    // office-reader's .xlsx reader; its test fails if the copy and the built-in ever differ.
    const pinnedCopies = ['excel-consolidation/skills/excel-consolidate/scripts/xlsx.mjs'];
    const offenders: string[] = [];
    for (const { dir } of useCases) {
      for (const name of await readdir(dir, { recursive: true })) {
        const file = name.split(path.sep).join('/');
        if (!/^(?:skills\/.+|mcp\/[^/]+)\.mjs$/u.test(file)) continue;
        if (pinnedCopies.includes(`${path.basename(dir)}/${file}`)) continue;
        const source = await readFile(path.join(dir, name), 'utf8');
        for (const reader of readers)
          if (reader.test(source))
            offenders.push(`${path.basename(dir)}/${file}: ${String(reader)}`);
      }
    }
    expect(offenders).toStrictEqual([]);
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

  it('the landing page shows every score the benchmarks give', async () => {
    const scores = new Map(useCases.map(({ benchmark }) => [benchmark.id, scoreOf(benchmark)]));
    const values = [...scores.values()];
    scores.set('min', Math.min(...values)).set('max', Math.max(...values));
    const text = await readFile(LANDING_PAGE, 'utf8');
    const shown = new Map<string, number>();
    const unknown: string[] = [];
    const expected = text.replace(LANDING_SCORE, (marker: string, id: string) => {
      const score = scores.get(id);
      if (score === undefined) {
        unknown.push(id);
        return marker;
      }
      shown.set(id, (shown.get(id) ?? 0) + 1);
      return `<!-- benchmark:score ${id} -->${String(score)}<!-- benchmark:end -->`;
    });
    expect(unknown, 'score markers naming no use case').toStrictEqual([]);
    // Each use case shows its score on its card, its tutorial line and the score table.
    for (const { benchmark } of useCases) {
      expect(shown.get(benchmark.id), `${benchmark.id} score markers`).toBe(3);
    }
    if (WRITE) {
      await writeFile(LANDING_PAGE, expected);
      return;
    }
    expect(text, 'sites/lp/use-cases.html is stale; run with GALLERY_WRITE=1').toBe(expected);
  });
});
