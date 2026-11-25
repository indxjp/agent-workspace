/**
 * `use-cases/SCOREBOARD.md` is generated from the catalog, the committed evidence and the entries'
 * files, and checked here like the gallery's tables: a hand edit, or a change the file does not
 * show, fails. `USE_CASES_WRITE=1 pnpm vitest run --project use-cases kit/scoreboard.test.ts`
 * rewrites it.
 *
 * The Coverage column needs the coverage run's summary (`USE_CASES_COVERAGE_SUMMARY`), which
 * `pnpm test` does not have. So the file is written with the summary, a run without one keeps the
 * committed Coverage cells, and the coverage job, which has the summary, runs this check again and
 * fails on a committed done cell the summary does not back. The file never flips between runs.
 */
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defineEntry } from '../../examples/store/catalog/define.ts';
import { CATALOG } from '../../examples/store/catalog/index.ts';
import { LINE_COUNTS } from '../../examples/store/catalog/line-counts.generated.ts';
import type { Recording } from '../../examples/store/catalog/recording.ts';
import { RECORDINGS } from '../../examples/store/catalog/recordings.generated.ts';
import { REAL_MODEL_EVIDENCE } from '../../examples/store/catalog/verification.ts';
import { CONTRACT_TESTS } from './contract.ts';
import { entrySourceHash } from '../../tests/store/live-verify/source-hash.ts';
import {
  CHECKS,
  claimedCoverage,
  contractPassed,
  galleryContractPassed,
  renderScoreboard,
  scoreEntries,
  type CoverageSummary,
  type ScoreInputs,
} from './scoreboard.ts';

const WRITE = process.env['USE_CASES_WRITE'] === '1';

/**
 * The coverage summary named by `USE_CASES_COVERAGE_SUMMARY` (the coverage job sets it after
 * `pnpm test:coverage:use-cases`); none otherwise, so the column stays not done.
 */
function coverageSummary(): CoverageSummary | null {
  const file = process.env['USE_CASES_COVERAGE_SUMMARY'];
  return file === undefined || file === ''
    ? null
    : (JSON.parse(readFileSync(file, 'utf8')) as CoverageSummary);
}

/** A summary with each of `files` (relative to `dir`) at 100 on all four measures. */
function full(dir: string, files: readonly string[]): CoverageSummary {
  const hundred = { pct: 100 };
  return Object.fromEntries(
    files.map((file) => [
      path.join(dir, file),
      { lines: hundred, branches: hundred, functions: hundred, statements: hundred },
    ]),
  );
}
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCOREBOARD = path.join(REPOSITORY_ROOT, 'use-cases', 'SCOREBOARD.md');

describe('the use cases scoreboard', () => {
  // Sized for 100 use cases: the contract run loads each project once, four workers at a time.
  it(
    'use-cases/SCOREBOARD.md equals the one generated from the catalog and the evidence',
    { timeout: 600_000 },
    async () => {
      const text = await readFile(SCOREBOARD, 'utf8').catch(() => '');
      const summary = coverageSummary();
      const rows = await scoreEntries({
        catalog: CATALOG,
        recordings: RECORDINGS,
        runs: REAL_MODEL_EVIDENCE.runs,
        lineCounts: LINE_COUNTS,
        repositoryRoot: REPOSITORY_ROOT,
        coverageSummary: summary,
        // Writing with a summary takes the summary's word; anything else is held to the file.
        claimed: WRITE && summary !== null ? null : claimedCoverage(text),
      });
      expect(rows).toHaveLength(CATALOG.length);
      const expected = renderScoreboard(rows);
      if (WRITE) {
        await writeFile(SCOREBOARD, expected);
        return;
      }
      expect(
        text,
        summary === null
          ? 'use-cases/SCOREBOARD.md is stale; run with USE_CASES_WRITE=1'
          : 'use-cases/SCOREBOARD.md is stale, or marks Coverage done where the summary is not at 100%; run pnpm test:coverage:use-cases, then USE_CASES_WRITE=1 with USE_CASES_COVERAGE_SUMMARY=coverage/use-cases/coverage-summary.json',
      ).toBe(expected);
    },
  );

  it(
    'marks only what it computed as done, and never page or safety yet',
    { timeout: 120_000 },
    async () => {
      const useCasesDir = fileURLToPath(new URL('./fixtures/use-case', import.meta.url));
      const liveInput = {
        slug: 'fixture-qa',
        area: 'mfg',
        status: 'live',
        wave: 1,
        kind: 'agent',
        source: 'use-cases/fixture-qa',
        name: { ja: 'あ', en: 'A' },
        summary: { ja: 'あ', en: 'A' },
        demo: {
          agent: 'fixture-qa',
          prompts: [{ ja: 'あ', en: 'A' }],
          moment: { ja: 'あ', en: 'A' },
          data: { ja: 'あ', en: 'A' },
          seed: [],
          check: { tools: ['search_files'], approval: null },
        },
        safety: ['files'],
      } as const;
      const live = defineEntry(liveInput);
      const app = defineEntry({
        ...liveInput,
        slug: 'wiki',
        kind: 'app',
        source: 'examples/wiki',
        demo: { ...liveInput.demo, agent: 'wiki' },
      });
      const soon = defineEntry({
        slug: 'nda',
        area: 'legal',
        status: 'soon',
        wave: 2,
        name: { ja: 'あ', en: 'A' },
        summary: { ja: 'あ', en: 'A' },
      });
      const turn = {
        prompt: 'あ',
        stopReason: 'end_turn',
        steps: [
          { kind: 'tool', name: 'search_files', input: {}, output: 'ok', isError: false } as const,
        ],
      };
      const recordings: Recording[] = (['ja', 'en'] as const).map((lang) => ({
        slug: 'fixture-qa',
        lang,
        recordedWith: 'scripted-model',
        turn,
      }));
      const hash = entrySourceHash(
        live,
        REPOSITORY_ROOT,
        path.relative(REPOSITORY_ROOT, path.join(useCasesDir, 'fixture-qa')),
      );
      if (hash === null) throw new Error('the fixture use case has no source to hash');
      const inputs: Omit<ScoreInputs, 'catalog'> = {
        recordings,
        runs: [
          {
            entry: 'fixture-qa',
            runId: 'run-1',
            date: '2026-11-21T00:00:00Z',
            result: 'pass',
            reason: 'the moment happened',
            environment: 'staging',
            sourceHash: hash,
          },
          // A pass for other code says nothing about this code.
          {
            entry: 'wiki',
            runId: 'run-2',
            date: '2026-11-21T00:00:00Z',
            result: 'pass',
            reason: 'the moment happened',
            environment: 'staging',
            sourceHash: 'b'.repeat(64),
          },
        ],
        lineCounts: { wiki: { handwritten: 10, budget: 100 } },
        repositoryRoot: REPOSITORY_ROOT,
        useCasesDir,
        coverageSummary: full(useCasesDir, [
          'fixture-qa/agents/fixture-qa.ts',
          'fixture-qa/surfaces/main.ts',
          'fixture-qa/skills/tally/scripts/tally.mjs',
        ]),
        claimed: null,
      };
      const rows = await scoreEntries({ ...inputs, catalog: [live, app, soon] });
      const done = (slug: string) =>
        CHECKS.filter((check) => rows.find((row) => row.slug === slug)?.done[check]);
      // Its own test ran its contract tier; it has no aw-generated.json, so its budget is not done.
      expect(done('fixture-qa')).toEqual(['contract', 'coverage', 'evals', 'moment', 'r1']);
      expect(done('wiki')).toEqual(['budget']);
      expect(done('nda')).toEqual([]);

      const text = renderScoreboard(rows);
      expect(text).toContain('Checks done: 6 of 24. Entries with all eight: 0 of 3.');
      expect(text).toContain(
        '| 1 | fixture-qa | mfg | live | — | ✅ | ⬜ | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ |',
      );
      expect(text).toContain(
        '| 3 | nda | legal | soon | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |',
      );

      // A live gallery entry rebuilt in the folder (`next`, ADR-0174) is scored as its rebuild: the
      // folder's contract, coverage, evals and the R1 record of the staged hash; its moment is
      // recorded at the repoint.
      const rebuilt = defineEntry({
        ...liveInput,
        source: 'tests/gallery/fixture-qa',
        demo: { ...liveInput.demo, agent: 'gallery-agent' },
        next: { source: 'use-cases/fixture-qa', demo: liveInput.demo },
      });
      const [row] = await scoreEntries({ ...inputs, catalog: [rebuilt] });
      expect(CHECKS.filter((check) => row?.done[check])).toEqual([
        'contract',
        'coverage',
        'evals',
        'r1',
      ]);
      expect(row?.status).toBe('live');

      // Negative: the only passing record is the current source's (the gallery agent visitors run
      // now), not the rebuild's, so the rebuild's R1 is not done.
      const onGallery = defineEntry({
        ...liveInput,
        source: 'tests/gallery/ringi-review',
        demo: { ...liveInput.demo, agent: 'ringi-review' },
        next: { source: 'use-cases/fixture-qa', demo: liveInput.demo },
      });
      const currentHash = entrySourceHash(onGallery, REPOSITORY_ROOT);
      if (currentHash === null) throw new Error('the gallery source has no files to hash');
      const [passed] = inputs.runs;
      if (passed === undefined) throw new Error('the inputs hold a passing record');
      const [current] = await scoreEntries({
        ...inputs,
        catalog: [onGallery],
        runs: [{ ...passed, sourceHash: currentHash }],
      });
      expect(current?.done.r1).toBe(false);
    },
  );

  it(
    'marks coverage done only from a summary at 100 on every code file of the use case',
    { timeout: 120_000 },
    async () => {
      const useCasesDir = fileURLToPath(new URL('./fixtures/use-case', import.meta.url));
      const catalog = [
        defineEntry({
          slug: 'fixture-soon',
          area: 'mfg',
          status: 'soon',
          wave: 2,
          name: { ja: 'あ', en: 'A' },
          summary: { ja: 'あ', en: 'A' },
        }),
      ];
      const coverage = async (
        summary: CoverageSummary | null,
        claimed: ReadonlySet<string> | null = null,
      ): Promise<boolean | undefined> =>
        (
          await scoreEntries({
            catalog,
            recordings: [],
            runs: [],
            lineCounts: {},
            repositoryRoot: REPOSITORY_ROOT,
            useCasesDir,
            coverageSummary: summary,
            claimed,
          })
        )[0]?.done.coverage;
      const covered = full(useCasesDir, ['fixture-soon/agents/fixture-soon.ts']);
      expect(await coverage(covered)).toBe(true);
      expect(await coverage(null)).toBe(false);
      expect(await coverage({})).toBe(false);
      const key = path.join(useCasesDir, 'fixture-soon/agents/fixture-soon.ts');
      const partial = { ...covered, [key]: { ...covered[key]!, branches: { pct: 50 } } };
      expect(await coverage(partial)).toBe(false);
      // Without a summary the committed cell is kept; with one, a claim needs the summary's backing.
      const claim = new Set(['fixture-soon']);
      expect(await coverage(null, claim)).toBe(true);
      expect(await coverage(null, new Set())).toBe(false);
      expect(await coverage(covered, claim)).toBe(true);
      expect(await coverage(partial, claim)).toBe(false);
      expect(await coverage(covered, new Set())).toBe(false);
    },
  );

  it('counts a contract tier only under describe(slug) > describe(contract), every test passed', () => {
    const all = Object.values(CONTRACT_TESTS);
    const at = (ancestorTitles: readonly string[], status = 'passed') =>
      all.map((title) => ({ ancestorTitles, title, status }));
    expect(contractPassed('nda', at(['nda', 'contract']))).toBe(true);
    expect(contractPassed('nda', at(['contract']))).toBe(false);
    expect(contractPassed('nda', at(['other', 'contract']))).toBe(false);
    expect(contractPassed('nda', at(['nda', 'contract', 'deeper']))).toBe(false);
    expect(contractPassed('nda', at(['nda', 'contract']).slice(1))).toBe(false);
    expect(
      contractPassed('nda', [
        ...at(['nda', 'contract']).slice(1),
        { ancestorTitles: ['nda', 'contract'], title: CONTRACT_TESTS.loads, status: 'failed' },
      ]),
    ).toBe(false);
  });

  it("counts a gallery project's contract only when its contract test ran and passed", () => {
    const test = (title: string, status = 'passed') => ({ title, status });
    expect(galleryContractPassed([test('the project passes the contract aw check applies')])).toBe(
      true,
    );
    expect(
      galleryContractPassed([
        test('the project and its embedded support widget pass the contract aw check applies'),
      ]),
    ).toBe(true);
    expect(galleryContractPassed([])).toBe(false);
    expect(galleryContractPassed([test('the eval file and the promotion bar are valid')])).toBe(
      false,
    );
    expect(
      galleryContractPassed([test('the project passes the contract aw check applies', 'failed')]),
    ).toBe(false);
    expect(
      galleryContractPassed([test('the project passes the contract aw check applies', 'skipped')]),
    ).toBe(false);
  });

  it(
    'leaves Contract not done for a test that only fakes a contract block',
    { timeout: 120_000 },
    async () => {
      const rows = await scoreEntries({
        catalog: [
          defineEntry({
            slug: 'fixture-fake',
            area: 'mfg',
            status: 'soon',
            wave: 2,
            name: { ja: 'あ', en: 'A' },
            summary: { ja: 'あ', en: 'A' },
          }),
        ],
        recordings: [],
        runs: [],
        lineCounts: {},
        repositoryRoot: REPOSITORY_ROOT,
        useCasesDir: fileURLToPath(new URL('./fixtures/use-case', import.meta.url)),
        coverageSummary: null,
        claimed: null,
      });
      expect(rows[0]?.done.contract).toBe(false);
    },
  );

  it('reads the claimed Coverage cells back from the committed Markdown', () => {
    const row = (at: number, slug: string, coverage: string) =>
      `| ${String(at)} | ${slug} | legal | soon | QA | ⬜ | ⬜ | ${coverage} | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |`;
    const table = [
      '| # | Entry | Area | Status | Archetype | Contract | Budget | Coverage | Evals | Moment | R1 | Page | Safety |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      row(1, 'nda', '✅'),
      row(2, 'faq', '⬜'),
      '',
      '- **Coverage**: | 3 | not-a-row | ✅ |',
    ].join('\n');
    expect([...claimedCoverage(table)]).toEqual(['nda']);
    expect(claimedCoverage('').size).toBe(0);
    expect(claimedCoverage('| # | Entry |\n| 1 | nda |').size).toBe(0);
  });
});
