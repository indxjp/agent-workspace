/**
 * The benchmark every gallery use case declares: one verdict per capability, and the evidence
 * behind it.
 *
 * A verdict is a claim about the SDK as it is today, and a claim without a test is an opinion, so
 * every cell names its evidence and `../benchmark.test.ts` checks that the evidence exists:
 *
 * - `contract` — the use case's own test proves it offline with the real SDK and real tools (the
 *   definition passes the server's contract; the flow runs against the scripted workspace).
 * - `probe` — a gap probe in `./probes.ts` asserts the capability is absent, and fails the day it
 *   arrives, so the benchmark cannot go stale silently.
 * - `live` — only a run on a real workspace and model proves it (`AW_GALLERY_LIVE=1`); offline, the
 *   cell is reported as not run rather than passed.
 * - `source` — read from the platform's source, cited by path, where no offline test can reach it.
 */

/** The capabilities a use case may need, in the gallery's column order. */
export const CAPABILITIES = [
  'agent',
  'search',
  'parse',
  'struct',
  'hitl',
  'write',
  'trigger',
  'scope',
  'ui',
  'eval',
  'audit',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_TITLES: Readonly<Record<Capability, string>> = {
  agent: 'Agent as code',
  search: 'Grounded search',
  parse: 'Document parsing',
  struct: 'Structured output',
  hitl: 'Human approval',
  write: 'Write to systems',
  trigger: 'Triggers',
  scope: 'Per-user scope',
  ui: 'Embedded UI',
  eval: 'Evals',
  audit: 'Audit and cost',
};

/**
 * The rubric every cell is scored by:
 *
 * - `ok`: the platform does it; the use case writes no code of its own for this capability.
 * - `work`: the use case does it with code it ships (an MCP server, a skill script, a backend step,
 *   a second run) and its offline suite exercises that code; or the platform does most of it and
 *   the use case covers the missing part itself.
 * - `gap`: the use case does not do it: the step is left to a person, to a system the gallery does
 *   not build, or is impossible today.
 * - `na`: the use case does not need it.
 */
export type Verdict = 'ok' | 'work' | 'gap' | 'na';
export type EvidenceKind = 'contract' | 'probe' | 'live' | 'source';

export interface Cell {
  readonly verdict: Verdict;
  readonly evidence: EvidenceKind;
  /**
   * For `contract` and `probe`, the exact title of the test that backs the cell; for `source`,
   * a repository path; for `live`, the eval case or check the live tier runs.
   */
  readonly ref: string;
  /** One sentence a reader of the tutorial sees beside the verdict. */
  readonly note: string;
}

export interface Benchmark {
  /** The use case's directory under `tests/gallery/` and its tutorial's file name. */
  readonly id: string;
  /** Its number in the gallery, 1 to 10: the order of the overview table and the docs navigation. */
  readonly order: number;
  readonly title: string;
  readonly cells: Readonly<Record<Capability, Cell | null>>;
}

/** Declare a use case's benchmark; `null` marks a capability the use case does not need. */
export function defineBenchmark(benchmark: Benchmark): Benchmark {
  return benchmark;
}

/** The score the gallery shows: ok = 1, work = 0.5, gap = 0, averaged over needed cells. */
export function scoreOf(benchmark: Benchmark): number {
  const needed = CAPABILITIES.flatMap((capability) => {
    const cell = benchmark.cells[capability];
    return cell === null ? [] : [cell.verdict];
  });
  const total = needed.reduce(
    (sum, verdict) => sum + (verdict === 'ok' ? 1 : verdict === 'work' ? 0.5 : 0),
    0,
  );
  return needed.length === 0 ? 0 : Math.round((total / needed.length) * 100);
}

const MARK: Readonly<Record<Verdict, string>> = { ok: '✅', work: '🟡', gap: '❌', na: '—' };

/**
 * The tutorial's "Where the SDK stands" table, rendered from the benchmark. The tutorial must
 * contain exactly this text between its markers; `../benchmark.test.ts` fails when they differ, and
 * `GALLERY_WRITE=1` rewrites them.
 */
export function renderStandingTable(benchmark: Benchmark): string {
  const rows = CAPABILITIES.flatMap((capability) => {
    const cell = benchmark.cells[capability];
    if (cell === null) return [];
    return [
      `| ${CAPABILITY_TITLES[capability]} | ${MARK[cell.verdict]} | ${cell.evidence} | ${cell.note} |`,
    ];
  });
  return [
    `Score: **${String(scoreOf(benchmark))} / 100** (✅ = 1, 🟡 = 0.5, ❌ = 0, over the capabilities this use case needs).`,
    '',
    '| Capability | Today | Evidence | What it means for you |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

const SHORT: Readonly<Record<Capability, string>> = {
  agent: 'Agent',
  search: 'Search',
  parse: 'Parse',
  struct: 'Struct',
  hitl: 'Approve',
  write: 'Write',
  trigger: 'Trigger',
  scope: 'Scope',
  ui: 'UI',
  eval: 'Eval',
  audit: 'Audit',
};

/** The gallery overview: one row per use case, one column per capability, and the score. */
export function renderOverviewTable(benchmarks: readonly Benchmark[]): string {
  const header = ['#', 'Use case', ...CAPABILITIES.map((capability) => SHORT[capability]), 'Score'];
  const rows = benchmarks.map((benchmark) => [
    String(benchmark.order),
    `[${benchmark.title}](/tutorials/${benchmark.id})`,
    ...CAPABILITIES.map((capability) => MARK[benchmark.cells[capability]?.verdict ?? 'na']),
    String(scoreOf(benchmark)),
  ]);
  return [header, header.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}
