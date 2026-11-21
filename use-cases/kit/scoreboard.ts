/**
 * `use-cases/SCOREBOARD.md` (SSOT §2, §8): one row per catalog entry, one column per check of the
 * definition of done, each worked out from the catalog, the committed evidence and the entry's
 * files. A check that cannot be computed yet is shown as not done, never typed in as done.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseProjectFile, readEvalCaseFile } from '@indx-workspace/sdk/project';

import type { CatalogEntry, LineCount } from '../../examples/store/catalog/define.ts';
import {
  judgeMoment,
  recordingFor,
  type Recording,
} from '../../examples/store/catalog/recording.ts';
import type { RealModelRun } from '../../examples/store/catalog/verification.ts';
import { filesOf } from '../../tests/apps/handwritten.ts';
import { countGalleryProject, GALLERY_CEILING } from '../../tests/gallery/harness/line-counts.ts';
import { entrySourceHash, passedForSource } from '../../tests/store/live-verify/source-hash.ts';
import { budgetProblems, isSkippedInUseCase, measureUseCase, MEASURED_CODE } from './budget.ts';
import { CONTRACT_TESTS, evalProblems } from './contract.ts';
import { REPOSITORY_ROOT, runVitest } from './nested-vitest.ts';

/** The eight checks of SSOT §8, in the scoreboard's column order. */
export const CHECKS = [
  'contract',
  'budget',
  'coverage',
  'evals',
  'moment',
  'r1',
  'page',
  'safety',
] as const;
type Check = (typeof CHECKS)[number];

const MARK = { done: '✅', open: '⬜' } as const;

const TITLES: Readonly<Record<Check, string>> = {
  contract: 'Contract',
  budget: 'Budget',
  coverage: 'Coverage',
  evals: 'Evals',
  moment: 'Moment',
  r1: 'R1',
  page: 'Page',
  safety: 'Safety',
};

/** What each column reads, printed under the table so a reader can check a cell. */
const MEANINGS: Readonly<Record<Check, string>> = {
  contract:
    "The contract tier of `use-cases/<slug>/<slug>.test.ts` (`describeUseCase`), run by the generator in a child Vitest, passed. For a gallery entry, its own test `tests/gallery/<id>/<id>.test.ts` proving the project passes the contract `aw check` applies (it loads the definitions through the server's schema and parses the eval file) passed, run the same way. App entries are checked by their own suites and are not counted here.",
  budget:
    'Handwritten lines within the archetype budget (`use-cases/benchmark.test.ts`), or, for a reference app, within its budget in `line-counts.generated.ts`, or, for a gallery entry, within the 150-line ceiling as `tests/gallery/harness/line-counts.ts` counts it (report-only: the table in `tests/gallery/README.md`).',
  coverage:
    'Every code file of the use case is at 100% on all four measures in the summary `pnpm test:coverage:use-cases` writes (`coverage/use-cases/coverage-summary.json`). The cell is written with that summary (`USE_CASES_COVERAGE_SUMMARY`); without one the committed cell is kept, and the coverage job fails when a committed done cell is not at 100%. Gallery entries are measured by `pnpm test:coverage:gallery`, whose floors are ratcheted toward 100, and are not done here until they move to `use-cases/`.',
  evals:
    "The demo agent's `evals/<agent>.yaml` has at least four cases tagged `suggested`, `other-language`, `out-of-scope` and `safety`, and the project's `policy.promotion.minEvalScore` is at least 0.9.",
  moment:
    'The entry is live and its committed JA and EN recordings pass `judgeMoment` against `demo.check`.',
  r1: "The entry's latest record in `examples/store/catalog/real-model-runs.json` for the current hash of its source folder (`tests/store/live-verify/source-hash.ts`) passed; a change to the source makes it stale.",
  page: 'Not computed yet: the landing-page fields, screenshots and social cards come with L1 to L3.',
  safety:
    'Not computed yet: no mapping from claimed safety properties to flows or eval cases exists.',
};

export interface ScoreRow {
  readonly slug: string;
  readonly area: string;
  readonly status: CatalogEntry['status'];
  readonly archetype: string | null;
  readonly done: Readonly<Record<Check, boolean>>;
}

export interface ScoreInputs {
  readonly catalog: readonly CatalogEntry[];
  readonly recordings: readonly Recording[];
  readonly runs: readonly RealModelRun[];
  readonly lineCounts: Readonly<Record<string, LineCount>>;
  readonly repositoryRoot: string;
  /** The `use-cases/` folder; `<repositoryRoot>/use-cases` by default. */
  readonly useCasesDir?: string;
  /** `coverage-summary.json` of `pnpm test:coverage:use-cases`, or `null` when there is none. */
  readonly coverageSummary: CoverageSummary | null;
  /**
   * The entries whose Coverage cell may be done: those the committed scoreboard marks done
   * ({@link claimedCoverage}). Without a summary such a cell is kept as committed; with one it is
   * done only if the summary agrees, so a check fails on a claim the summary does not back. `null`
   * claims nothing in advance: the cell is what the summary says (how the generator writes it).
   */
  readonly claimed: ReadonlySet<string> | null;
}

interface Measure {
  readonly pct: number;
}
/** A v8 `json-summary`: per absolute file path, the four measures. */
export type CoverageSummary = Readonly<
  Record<
    string,
    {
      readonly lines: Measure;
      readonly branches: Measure;
      readonly functions: Measure;
      readonly statements: Measure;
    }
  >
>;

interface JsonReport {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly {
      readonly ancestorTitles: readonly string[];
      readonly title: string;
      readonly status: string;
    }[];
  }[];
}

/** One use case's own test file, for the contract run. */
interface ContractRun {
  readonly slug: string;
  readonly file: string;
}

/**
 * Whether `assertions` show `describeUseCase(slug)`'s whole contract tier passing: every one of
 * {@link CONTRACT_TESTS} ran under exactly `describe(slug) > describe('contract')` and passed. A
 * `describe('contract')` of any other shape counts for nothing.
 */
export function contractPassed(
  slug: string,
  assertions: readonly {
    readonly ancestorTitles: readonly string[];
    readonly title: string;
    readonly status: string;
  }[],
): boolean {
  const passed = new Set(
    assertions
      .filter(
        ({ ancestorTitles, status }) =>
          ancestorTitles.length === 2 &&
          ancestorTitles[0] === slug &&
          ancestorTitles[1] === 'contract' &&
          status === 'passed',
      )
      .map(({ title }) => title),
  );
  return Object.values(CONTRACT_TESTS).every((title) => passed.has(title));
}

type Assertions = JsonReport['testResults'][number]['assertionResults'];

/**
 * Run the tests of `project` that `-t pattern` names, in the given test files (absolute), in one
 * child Vitest with the parent's worker cap, and answer each file's assertions; a file the run did
 * not report has none.
 */
function childAssertions(
  project: string,
  pattern: string,
  files: readonly string[],
): Map<string, Assertions> {
  const out = mkdtempSync(path.join(tmpdir(), `${project}-contract-`));
  try {
    const report = path.join(out, 'report.json');
    runVitest([
      '--project',
      project,
      '--reporter=json',
      `--outputFile=${report}`,
      '-t',
      pattern,
      ...files.map((file) => path.relative(REPOSITORY_ROOT, file)),
    ]);
    const parsed = existsSync(report)
      ? (JSON.parse(readFileSync(report, 'utf8')) as JsonReport)
      : { testResults: [] };
    return new Map(
      files.map((file) => [
        file,
        parsed.testResults.find((candidate) => candidate.name === file)?.assertionResults ?? [],
      ]),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Run only the contract tests (`-t '^<slug> > contract > '`) of the given use cases' own test files,
 * and answer per absolute file whether {@link contractPassed}.
 */
function contractResults(runs: readonly ContractRun[]): Map<string, boolean> {
  if (runs.length === 0) return new Map();
  const assertions = childAssertions(
    'use-cases',
    `^(?:${runs.map(({ slug }) => slug).join('|')}) > contract > `,
    runs.map(({ file }) => file),
  );
  return new Map(
    runs.map(({ slug, file }) => [file, contractPassed(slug, assertions.get(file) ?? [])]),
  );
}

/** A gallery test's title for its contract tier: the project loads the way `aw check` loads it. */
const GALLERY_CONTRACT = /\bpass(?:es)? the contract aw check applies$/u;

/**
 * Whether `assertions` (one gallery `<id>.test.ts`) show its contract test passing: at least one
 * test with the {@link GALLERY_CONTRACT} title ran, and every one that ran passed.
 */
export function galleryContractPassed(
  assertions: readonly { readonly title: string; readonly status: string }[],
): boolean {
  const contract = assertions.filter(({ title }) => GALLERY_CONTRACT.test(title));
  return contract.length > 0 && contract.every(({ status }) => status === 'passed');
}

/**
 * Run only the contract tests of the given gallery projects' own test files (the `tests-gallery`
 * project), and answer per absolute file whether {@link galleryContractPassed}.
 */
function galleryContractResults(files: readonly string[]): Map<string, boolean> {
  if (files.length === 0) return new Map();
  const assertions = childAssertions('tests-gallery', GALLERY_CONTRACT.source, files);
  return new Map(files.map((file) => [file, galleryContractPassed(assertions.get(file) ?? [])]));
}

/** The gallery project a live catalog entry is built from, or `null` for any other entry. */
function galleryDir(entry: CatalogEntry, repositoryRoot: string): string | null {
  return entry.status === 'live' && entry.source.startsWith('tests/gallery/')
    ? path.join(repositoryRoot, entry.source)
    : null;
}

/** The gallery project's own test file, which holds its contract test. */
const galleryTestFile = (dir: string): string => path.join(dir, `${path.basename(dir)}.test.ts`);

/** Whether every code file of the use case in `dir` is at 100% on all four measures in `summary`. */
async function coverageDone(dir: string, summary: CoverageSummary): Promise<boolean> {
  const code = (await filesOf(dir)).filter(
    (file) => MEASURED_CODE.test(file) && !isSkippedInUseCase(file),
  );
  return code.every((file) => {
    const measured = summary[path.join(dir, file)];
    return (
      measured !== undefined &&
      [measured.lines, measured.branches, measured.functions, measured.statements].every(
        ({ pct }) => pct === 100,
      )
    );
  });
}

/**
 * The slugs whose Coverage cell `scoreboard` (the committed Markdown) marks done; none for a file
 * that is missing or has no table.
 */
export function claimedCoverage(scoreboard: string): ReadonlySet<string> {
  const lines = scoreboard.split('\n');
  const header = lines
    .find((line) => line.startsWith('| # |'))
    ?.split('|')
    .map((cell) => cell.trim());
  const entry = header?.indexOf('Entry') ?? -1;
  const coverage = header?.indexOf(TITLES.coverage) ?? -1;
  if (entry < 0 || coverage < 0) return new Set();
  return new Set(
    lines
      .filter((line) => /^\| \d+ \|/u.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((cells) => cells[coverage] === MARK.done)
      .flatMap((cells) => cells[entry] ?? []),
  );
}

/**
 * The Coverage cell of a use case: what the summary says, limited to what is claimed
 * ({@link ScoreInputs.claimed}); the claim alone when there is no summary to check it against.
 */
async function coverageCell(slug: string, dir: string, inputs: ScoreInputs): Promise<boolean> {
  if (inputs.coverageSummary === null) return inputs.claimed?.has(slug) ?? false;
  const claimed = inputs.claimed === null || inputs.claimed.has(slug);
  return claimed && (await coverageDone(dir, inputs.coverageSummary));
}

/** Whether the agent's evals and the project's promotion bar meet SSOT §5.3; false if unreadable. */
async function evalsDone(dir: string, agent: string): Promise<boolean> {
  const evalsFile = path.join(dir, 'evals', `${agent}.yaml`);
  const projectFile = path.join(dir, 'agent-workspace.yaml');
  if (!existsSync(evalsFile) || !existsSync(projectFile)) return false;
  try {
    const evals = readEvalCaseFile(await readFile(evalsFile, 'utf8'), `evals/${agent}.yaml`);
    const read = parseProjectFile(await readFile(projectFile, 'utf8'));
    const bar = read.lifted ? undefined : read.project.policy?.promotion?.minEvalScore;
    return evalProblems(agent, evals, bar).length === 0;
  } catch {
    return false;
  }
}

function momentDone(entry: CatalogEntry, recordings: readonly Recording[]): boolean {
  if (entry.status !== 'live' || entry.demo.check === undefined) return false;
  const check = entry.demo.check;
  return (['ja', 'en'] as const).every((lang) => {
    const recording = recordingFor(recordings, entry.slug, lang);
    return recording !== null && judgeMoment(recording.turn, check).pass;
  });
}

async function scoreEntry(
  entry: CatalogEntry,
  inputs: ScoreInputs,
  contracts: ReadonlyMap<string, boolean>,
): Promise<ScoreRow> {
  const useCasesDir = inputs.useCasesDir ?? path.join(inputs.repositoryRoot, 'use-cases');
  const useCase = path.join(useCasesDir, entry.slug);
  const isUseCase = existsSync(path.join(useCase, 'agent-workspace.yaml'));
  const source = isUseCase
    ? useCase
    : entry.status === 'live'
      ? path.join(inputs.repositoryRoot, entry.source)
      : null;
  const agent = entry.status === 'live' ? entry.demo.agent : entry.slug;
  const measure = isUseCase ? await measureUseCase(useCase, useCasesDir) : null;
  const gallery = galleryDir(entry, inputs.repositoryRoot);
  const contract =
    contracts.get(
      gallery === null ? path.join(useCase, `${entry.slug}.test.ts`) : galleryTestFile(gallery),
    ) === true;
  const appId = entry.status === 'live' && entry.kind === 'app' ? path.basename(entry.source) : '';
  const lineCount = inputs.lineCounts[appId];
  const budget =
    measure !== null
      ? budgetProblems(measure).length === 0
      : gallery !== null
        ? (await countGalleryProject(gallery)).lines <= GALLERY_CEILING
        : lineCount !== undefined && lineCount.handwritten <= lineCount.budget;
  const coverage = isUseCase && (await coverageCell(entry.slug, useCase, inputs));
  const hash =
    source === null
      ? null
      : entrySourceHash(entry, inputs.repositoryRoot, path.relative(inputs.repositoryRoot, source));
  return {
    slug: entry.slug,
    area: entry.area,
    status: entry.status,
    archetype: measure?.archetype ?? null,
    done: {
      contract,
      budget,
      coverage,
      evals: source !== null && (await evalsDone(source, agent)),
      moment: momentDone(entry, inputs.recordings),
      r1: passedForSource(entry.slug, hash, inputs.runs),
      page: false,
      safety: false,
    },
  };
}

/** Every catalog entry's row, in catalog order. */
export async function scoreEntries(inputs: ScoreInputs): Promise<ScoreRow[]> {
  const useCasesDir = inputs.useCasesDir ?? path.join(inputs.repositoryRoot, 'use-cases');
  const runs = inputs.catalog
    .map(({ slug }) => ({ slug, file: path.join(useCasesDir, slug, `${slug}.test.ts`) }))
    .filter(({ file }) => existsSync(file));
  const galleries = inputs.catalog
    .flatMap((entry) => galleryDir(entry, inputs.repositoryRoot) ?? [])
    .map(galleryTestFile)
    .filter((file) => existsSync(file));
  const contracts = new Map([...contractResults(runs), ...galleryContractResults(galleries)]);
  return Promise.all(inputs.catalog.map((entry) => scoreEntry(entry, inputs, contracts)));
}

/** The scoreboard's Markdown. */
export function renderScoreboard(rows: readonly ScoreRow[]): string {
  const cells = rows.length * CHECKS.length;
  const done = rows.reduce((sum, row) => sum + CHECKS.filter((check) => row.done[check]).length, 0);
  const complete = rows.filter((row) => CHECKS.every((check) => row.done[check])).length;
  const header = ['#', 'Entry', 'Area', 'Status', 'Archetype', ...CHECKS.map((c) => TITLES[c])];
  const lines = rows.map((row, at) =>
    [
      String(at + 1),
      row.slug,
      row.area,
      row.status,
      row.archetype ?? '—',
      ...CHECKS.map((check) => (row.done[check] ? MARK.done : MARK.open)),
    ].join(' | '),
  );
  return [
    '# Use cases scoreboard',
    '',
    '<!-- Generated by `USE_CASES_WRITE=1 pnpm vitest run --project use-cases kit/scoreboard.test.ts`. Do not edit by hand: use-cases/kit/scoreboard.test.ts fails when this file differs. -->',
    '',
    'One row per catalog entry, one column per check of the definition of done',
    '(section 8 of the plan, `use-cases-100-plan.md`). Every cell is computed; a check that',
    'cannot be computed yet is shown as not done.',
    '',
    `Checks done: ${String(done)} of ${String(cells)}. Entries with all eight: ${String(complete)} of ${String(rows.length)}.`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...lines.map((line) => `| ${line} |`),
    '',
    `${MARK.done} done · ${MARK.open} not done, or not computed yet`,
    '',
    '## What each check reads',
    '',
    ...CHECKS.map((check) => `- **${TITLES[check]}**: ${MEANINGS[check]}`),
    '',
  ].join('\n');
}
