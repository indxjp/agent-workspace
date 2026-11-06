export type LaneStep =
  'regenerate' | 'install' | 'build' | 'test' | 'depcruise' | 'journeys' | 'self-host';
export type LaneCell = 'generated' | 'journeys' | 'agentOnData' | 'selfHost' | 'noFork';
export type StepOutcome = {
  readonly status: 'ok' | 'failed' | 'gap';
  readonly reason: string;
};
export type CellVerdicts = Record<
  LaneCell,
  { readonly verdict: 'ok' | 'gap'; readonly reasons: string[] }
>;
type DeclaredBenchmark = {
  readonly id: string;
  readonly cells: Readonly<
    Record<
      'journeys' | 'agentOnData' | 'selfHost',
      { readonly verdict: 'ok' | 'gap'; readonly ref: string }
    >
  > & {
    readonly journeys: { readonly alsoExcused?: readonly string[] };
  };
};

export const LANE_STEPS: readonly LaneStep[];
export const STEP_CELLS: Readonly<Record<LaneStep, LaneCell>>;
export const STEP_NEEDS: Readonly<Record<LaneStep, readonly LaneStep[]>>;
export const LANE_CELLS: readonly LaneCell[];
export type LaneScenario = 'blueprint';
export const LANE_SCENARIOS: readonly LaneScenario[];
export const PLATFORM_URL: string;
export function appUrl(name: string): string;
export function appSchema(name: string): string;
export function parseLaneArgs(
  argv: readonly string[],
  registered: readonly string[],
): { apps: string[]; skip: Set<LaneStep | LaneScenario> };
export function blockedReason(
  step: LaneStep,
  outcomes: ReadonlyMap<string, { readonly status: string }>,
  skip: ReadonlySet<string>,
): string | undefined;
export function cellVerdicts(outcomes: ReadonlyMap<string, StepOutcome>): CellVerdicts;
export function claimedVerdict(benchmark: DeclaredBenchmark, cell: LaneCell): 'ok' | 'gap';
export function laneFindings(
  benchmark: DeclaredBenchmark,
  verdicts: CellVerdicts,
  unexcused?: readonly string[],
): { failures: string[]; notices: string[] };
export function journeyResults(report: { suites?: unknown[] }): { title: string; ok: boolean }[];
export function journeysOutcome(
  benchmark: DeclaredBenchmark,
  results: readonly { readonly title: string; readonly ok: boolean }[],
): StepOutcome & { readonly unexcused: string[] };
export const TEST_RESULTS_REPORTER: string;
export type TestResult = {
  readonly title: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'todo';
};
export function testResults(text: string): TestResult[];
export function agentOnDataOutcome(
  benchmark: { readonly cells: { readonly agentOnData: { readonly ref: string } } },
  command: { readonly status: number; readonly reason: string },
  results: readonly TestResult[],
): StepOutcome;
export function withProductionApps(
  projectYaml: string,
  apps: Readonly<Record<string, string>>,
  target: 'single-vm' | 'kubernetes',
): string;
export function standInImage(name: string): string;
export function composeAppsProblem(
  compose: unknown,
  name: string,
  image: string,
): string | undefined;
export function helmAppsProblem(values: unknown, name: string, image: string): string | undefined;
export function withTarballDependencies(
  manifest: Record<string, unknown>,
  tarballs: Readonly<Record<string, string>>,
): Record<string, unknown>;
export function renderLaneSummary(
  results: readonly {
    readonly benchmark: { readonly id: string };
    readonly verdicts: CellVerdicts;
  }[],
): string;
export function renderScenarioSummary(id: string, outcome: StepOutcome): string;
export const JOURNEY_LOCALES: readonly ('en' | 'ja')[];
export function withThemeLocale(source: string, locale: string): string | undefined;
export function journeyEnv(
  base: Record<string, string | undefined>,
  run: {
    appUrl: string;
    origin: string;
    token: string;
    copy: string;
    locale: string;
    report: string;
    owner: { email: string; password: string };
  },
): Record<string, string | undefined>;
export function attemptAsync(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ status: number; stdout: string; output: string }>;
