import { JourneyFailure } from './harness-failure.mjs';

/**
 * The exit criterion's budget, in seconds: `npm create` to an answering widget in ten minutes or
 * less (plan §1). It is a constant on purpose: no option, variable or report field can raise it.
 */
export const JOURNEY_BUDGET_SECONDS = 600;

/** B2's budget (S2-08): a colour written to `surfaces/main.ts` shows in the launcher within 60 s. */
export const JOURNEY_LOOK_CHANGE_BUDGET_SECONDS = 60;

/** B3's budget (S2-08): an OpenAPI document becomes a tool the widget answers with in 900 s. */
export const JOURNEY_TOOL_BUDGET_SECONDS = 900;

/**
 * J1's budget (issue #1510): from the start of `npm create … --template portal` to the first page
 * of the portal a person sees signed in, ten minutes or less. Declared on its own so that B1's
 * budget can never be changed by changing J1's, though today both are 600 s.
 */
export const JOURNEY_PORTAL_BUDGET_SECONDS = 600;

/**
 * The only budgets a report may be checked against: no other value is accepted anywhere. Each
 * value once, so a refusal lists it once even when two blocks share it.
 */
const BUDGETS = [
  ...new Set([
    JOURNEY_BUDGET_SECONDS,
    JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
    JOURNEY_TOOL_BUDGET_SECONDS,
    JOURNEY_PORTAL_BUDGET_SECONDS,
  ]),
];

/** @param {number} seconds */
function declaredBudget(seconds) {
  if (!BUDGETS.includes(seconds)) {
    throw new JourneyFailure(
      `${String(seconds)} s is not a journey budget; the budgets are ${BUDGETS.join(', ')} s`,
    );
  }
  return seconds;
}

/** Below this, a command cannot run: a deadline this close is reported as run out. */
export const MIN_COMMAND_MS = 5_000;

/** @param {number} seconds */
function tenths(seconds) {
  return Math.round(seconds * 10) / 10;
}

/**
 * Rounded up to a tenth, so that a rounded total never understates the measurement: 600.04 s is
 * recorded as 600.1 s, over the budget wherever it is read.
 *
 * @param {number} seconds
 */
function tenthsUp(seconds) {
  return Math.ceil(seconds * 10 - 1e-9) / 10;
}

/** @param {readonly {name: string, seconds: number}[]} steps @param {number} wallSeconds */
function validatedStepsTotal(steps, wallSeconds) {
  for (const step of steps) {
    if (!Number.isFinite(step.seconds) || step.seconds < 0) {
      throw new JourneyFailure(`step ${step.name} has no valid duration`);
    }
  }
  const stepsTotal = steps.reduce((sum, step) => sum + step.seconds, 0);
  if (!Number.isFinite(wallSeconds) || wallSeconds < stepsTotal - 1e-6) {
    throw new JourneyFailure('the wall-clock time is shorter than the sum of the steps');
  }
  return stepsTotal;
}

/**
 * The timing record of one timed block against its fixed budget. `wallSeconds` is the block's
 * wall-clock time (for B1, from the start of `npm create` to the answer), the harness's work
 * between the steps included; it is the total the budget is checked against, rounded up. Each
 * step's own seconds are kept beside it. It takes the steps and the wall clock alone; anything
 * else (a budget among them) is refused, and `budgetSeconds` must be one of the declared budgets.
 * `finished: true` tells it apart from {@link unfinishedTimingsReport}'s record.
 *
 * @param {{ steps: readonly { name: string, seconds: number }[], wallSeconds: number }} input
 * @param {number} [budgetSeconds]
 */
export function timingsReport(input, budgetSeconds = JOURNEY_BUDGET_SECONDS) {
  const budget = declaredBudget(budgetSeconds);
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'steps' || keys[1] !== 'wallSeconds') {
    throw new JourneyFailure(
      `timingsReport takes only steps and wallSeconds; the budget is fixed at ${String(budget)} s`,
    );
  }
  if (input.steps.length === 0) throw new JourneyFailure('the journey measured no step');
  const stepsTotal = validatedStepsTotal(input.steps, input.wallSeconds);
  const totalSeconds = tenthsUp(input.wallSeconds);
  return {
    budgetSeconds: budget,
    finished: /** @type {const} */ (true),
    totalSeconds,
    stepsSeconds: tenths(stepsTotal),
    withinBudget: totalSeconds <= budget,
    steps: input.steps.map((step) => ({ name: step.name, seconds: tenths(step.seconds) })),
  };
}

/** @typedef {ReturnType<typeof timingsReport>} TimingsReport */

/**
 * `journey: <label> <n> s (budget <b> s)`, `<n>` the wall clock: `journey: total 165.1 s (budget
 * 600 s)` for B1, `journey: B2 look change 12.3 s (budget 60 s)` for B2.
 *
 * @param {import('./harness.d.mts').TimingsReport} report @param {string} [label]
 */
export function totalLine(report, label = 'total') {
  return `journey: ${label} ${String(report.totalSeconds)} s (budget ${String(declaredBudget(report.budgetSeconds))} s)`;
}

/**
 * The record as a Markdown table, for `$GITHUB_STEP_SUMMARY`.
 *
 * @param {TimingsReport} report @param {string} [title]
 */
export function stepSummaryMarkdown(report, title = 'Slice-1 journey') {
  const budget = declaredBudget(report.budgetSeconds);
  return [
    `### ${title} (budget ${String(budget)} s)`,
    '',
    '| Step | Seconds |',
    '| --- | ---: |',
    ...report.steps.map((step) => `| ${step.name} | ${String(step.seconds)} |`),
    `| Sum of the steps | ${String(report.stepsSeconds)} |`,
    `| **Total (wall clock)** | **${String(report.totalSeconds)}** |`,
    '',
    "The total is the block's wall-clock time (for the slice-1 journey, from the start of " +
      "`npm create` to the answer), the harness's work between the steps included, rounded up " +
      'to a tenth of a second.',
    '',
    report.totalSeconds <= budget ? 'Within budget.' : 'Over budget.',
    '',
  ].join('\n');
}

/**
 * The timing record of a run that stopped inside a timed step: the steps that finished, the one
 * that failed with the seconds it ran before it failed, and the wall clock up to the failure. It is
 * written in place of {@link timingsReport}'s record, so the timings the workflow keeps "always"
 * exist for a red run too. It carries no total and no budget verdict: nothing was answered.
 *
 * @param {{ steps: readonly { name: string, seconds: number }[], failed: { name: string, seconds: number }, elapsedSeconds: number }} input
 * @param {number} [budgetSeconds]
 */
export function unfinishedTimingsReport(input, budgetSeconds = JOURNEY_BUDGET_SECONDS) {
  const budget = declaredBudget(budgetSeconds);
  const measured = [...input.steps, input.failed];
  validatedStepsTotal(measured, input.elapsedSeconds);
  return {
    budgetSeconds: budget,
    finished: /** @type {const} */ (false),
    elapsedSeconds: tenthsUp(input.elapsedSeconds),
    failedStep: { name: input.failed.name, seconds: tenths(input.failed.seconds) },
    steps: input.steps.map((step) => ({ name: step.name, seconds: tenths(step.seconds) })),
  };
}

/** @typedef {ReturnType<typeof unfinishedTimingsReport>} UnfinishedTimingsReport */

/**
 * B1's unfinished `journey-timings.json` record: the unfinished report and which `model` answered
 * (`fake` or `live`), so a failed live run's record is told apart from a failed stub run's.
 *
 * @param {import('./harness.d.mts').UnfinishedTimingsReport} report @param {'fake' | 'live'} model
 */
export function unfinishedJourneyRecord(report, model) {
  return { ...report, model };
}

/**
 * An unfinished record as Markdown, for `$GITHUB_STEP_SUMMARY`.
 *
 * @param {import('./harness.d.mts').UnfinishedTimingsReport} report @param {string} [title]
 */
export function unfinishedSummaryMarkdown(report, title = 'Slice-1 journey') {
  return [
    `### ${title} (budget ${String(declaredBudget(report.budgetSeconds))} s): failed`,
    '',
    '| Step | Seconds |',
    '| --- | ---: |',
    ...report.steps.map((step) => `| ${step.name} | ${String(step.seconds)} |`),
    `| ${report.failedStep.name} (failed) | ${String(report.failedStep.seconds)} |`,
    `| **Wall clock until the failure** | **${String(report.elapsedSeconds)}** |`,
    '',
    'The journey stopped inside a timed step, so no total is checked against the budget.',
    '',
  ].join('\n');
}

/**
 * The total is at most `seconds`, one of the declared budget constants (B1's
 * {@link JOURNEY_BUDGET_SECONDS} by default) and never read from the report, or the run fails
 * naming the slowest step.
 *
 * @param {TimingsReport} report @param {number} [seconds]
 */
export function assertWithinBudget(report, seconds = JOURNEY_BUDGET_SECONDS) {
  const budget = declaredBudget(seconds);
  if (report.totalSeconds <= budget) return;
  const slowest = report.steps.reduce((worst, step) =>
    step.seconds > worst.seconds ? step : worst,
  );
  throw new JourneyFailure(
    `the journey took ${String(report.totalSeconds)} s, over the ${String(budget)} s budget; ` +
      `the slowest step was ${slowest.name} (${String(slowest.seconds)} s)`,
  );
}

/**
 * What is left before `deadline`, for one command's timeout. With less than
 * {@link MIN_COMMAND_MS} left, the run stops naming `variable`, the cap that ran out, instead of
 * starting a command that would be killed at once.
 *
 * @param {number} deadline epoch milliseconds @param {number} now epoch milliseconds
 * @param {string} variable
 */
export function remainingMs(deadline, now, variable) {
  const left = deadline - now;
  if (left < MIN_COMMAND_MS) throw new JourneyFailure(`the run ran out of ${variable}`);
  return left;
}

/** The line a widget test prints for the first-token latency: `journey-first-token-ms <n>`. */
const FIRST_TOKEN_LINE = /journey-first-token-ms (\d+)$/u;

/**
 * The first-token latency, in seconds to a tenth, from the one `journey-first-token-ms <n>` line
 * of a widget test's output.
 *
 * @param {string} output
 */
export function firstTokenOf(output) {
  const found = output
    .split('\n')
    .map((line) => FIRST_TOKEN_LINE.exec(line.replace(/\r$/u, '').trim()))
    .filter((match) => match !== null);
  const [match] = found;
  if (match === undefined || found.length !== 1) {
    throw new JourneyFailure(
      `the widget test printed ${String(found.length)} journey-first-token-ms lines, not one`,
    );
  }
  return tenths(Number(match[1]) / 1000);
}

/**
 * The first-hour stopwatch's record as Markdown, for `$GITHUB_STEP_SUMMARY`: a timed step shows
 * its seconds, and its target when it has one; a pending step names the issue it waits for.
 *
 * @param {readonly { id: string, name: string, seconds?: number, targetSeconds?: number, pending?: string }[]} steps
 */
export function firstHourSummaryMarkdown(steps) {
  return [
    '### First-hour stopwatch (B0)',
    '',
    '| Step | Seconds | Target | State |',
    '| --- | ---: | ---: | --- |',
    ...steps.map((step) => {
      const target = step.targetSeconds === undefined ? '' : String(step.targetSeconds);
      if (step.seconds === undefined) {
        return `| ${step.id} ${step.name} | | ${target} | pending ${step.pending ?? ''} |`;
      }
      const over = step.targetSeconds !== undefined && step.seconds > step.targetSeconds;
      return `| ${step.id} ${step.name} | ${step.seconds.toFixed(1)} | ${target} | ${over ? 'over target' : 'timed'} |`;
    }),
    '',
  ].join('\n');
}
