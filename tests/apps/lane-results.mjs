/* global console */
import { LANE_STEPS, STEP_CELLS, STEP_NEEDS, LANE_CELLS, DECLARED_CELLS } from './lane-config.mjs';
export { parseLaneArgs } from './lane-arguments.mjs';
export { journeyResults, testResults } from './lane-report-parsers.mjs';

/**
 * Why `step` cannot run, given the outcomes so far and the skipped steps; `undefined` when it can.
 *
 * @param {string} step @param {ReadonlyMap<string, { status: string }>} outcomes
 * @param {ReadonlySet<string>} skip
 */
export function blockedReason(step, outcomes, skip) {
  if (skip.has(step)) return 'skipped by --skip';
  const failed = STEP_NEEDS[step].find((need) => outcomes.get(need)?.status !== 'ok');
  return failed === undefined ? undefined : `needs ${failed}, which did not pass`;
}

/**
 * Each lane cell's verdict from its steps' outcomes: `ok` only when it has steps and every one
 * passed; otherwise a `gap` with each step's reason.
 *
 * @param {ReadonlyMap<string, { status: 'ok' | 'failed' | 'gap', reason: string }>} outcomes
 * @returns {Record<string, { verdict: 'ok' | 'gap', reasons: string[] }>}
 */
export function cellVerdicts(outcomes) {
  /** @type {Record<string, { verdict: 'ok' | 'gap', reasons: string[] }>} */
  const verdicts = {};
  for (const cell of LANE_CELLS) {
    const steps = LANE_STEPS.filter((step) => STEP_CELLS[step] === cell);
    const reasons = steps.flatMap((step) => {
      const outcome = outcomes.get(step);
      if (outcome === undefined) return [`${step}: did not run`];
      return outcome.status === 'ok' ? [] : [`${step}: ${outcome.reason}`];
    });
    verdicts[cell] = { verdict: reasons.length === 0 ? 'ok' : 'gap', reasons };
  }
  return verdicts;
}

/**
 * What the app claims for `cell`: its declared verdict, or `ok` for a computed cell.
 *
 * @param {{ cells: Record<string, { verdict: 'ok' | 'gap' }> }} benchmark @param {string} cell
 */
export function claimedVerdict(benchmark, cell) {
  return DECLARED_CELLS.includes(cell) ? (benchmark.cells[cell]?.verdict ?? 'gap') : 'ok';
}

/**
 * The lane's findings for one app: `failures` (a claimed `ok` measured as a gap, and each journey
 * problem no declared gap excuses) fail the run; `notices` (a declared gap measured `ok`) do not.
 *
 * @param {{ id: string, cells: Record<string, { verdict: 'ok' | 'gap' }> }} benchmark
 * @param {Record<string, { verdict: 'ok' | 'gap', reasons: string[] }>} verdicts
 * @param {readonly string[]} [unexcused] the journeys step's problems no declared gap excuses
 */
export function laneFindings(benchmark, verdicts, unexcused = []) {
  /** @type {string[]} */
  const failures = unexcused.map((problem) => `${benchmark.id}: ${problem}`);
  /** @type {string[]} */
  const notices = [];
  for (const cell of LANE_CELLS) {
    const measured = verdicts[cell]?.verdict ?? 'gap';
    const claimed = claimedVerdict(benchmark, cell);
    if (claimed === 'ok' && measured === 'gap') {
      failures.push(
        `${benchmark.id}.${cell} is claimed ok but measured a gap: ${(verdicts[cell]?.reasons ?? []).join('; ')}`,
      );
    } else if (claimed === 'gap' && measured === 'ok') {
      notices.push(`${benchmark.id}.${cell} is declared a gap but passed; declare it ok`);
    }
  }
  return { failures, notices };
}

/**
 * The journeys step from the app's results: `ok` when at least one ran and every one passed;
 * else `failed`. A declared Journeys gap excuses exactly the failures of the journeys it names:
 * its ref and each title of its `alsoExcused` (`benchmark.test.ts` allows those on a gap only).
 * Every other failure, and a run with no journey or none of a named title, is `unexcused`, which
 * fails the lane whatever the app declares.
 *
 * @param {{ cells: { journeys: { verdict: 'ok' | 'gap', ref: string, alsoExcused?: readonly string[] } } }} benchmark
 * @param {readonly { title: string, ok: boolean }[]} results
 */
export function journeysOutcome(benchmark, results) {
  const failed = results.filter((result) => !result.ok).map((result) => result.title);
  const { verdict, ref, alsoExcused = [] } = benchmark.cells.journeys;
  const named = [ref, ...alsoExcused];
  const unexcused = failed
    .filter((title) => verdict !== 'gap' || !named.includes(title))
    .map((title) => `the journey '${title}' failed`);
  if (results.length === 0) {
    return { status: 'failed', reason: 'no journey ran', unexcused: ['no journey ran'] };
  }
  const missing = named
    .filter((title) => !results.some((result) => result.title === title))
    .map((title) => `no journey is titled '${title}'`);
  if (missing.length > 0) {
    return { status: 'failed', reason: missing.join('; '), unexcused: [...unexcused, ...missing] };
  }
  return failed.length === 0
    ? { status: 'ok', reason: `${String(results.length)} journeys passed`, unexcused: [] }
    : { status: 'failed', reason: `failed: ${failed.join(', ')}`, unexcused };
}

/**
 * The test step from the command's exit status and its per-test results: `ok` only when the
 * command passed and a test titled exactly as `agentOnData.ref` ran and passed, every one of that
 * title. A ref test that is missing, skipped or todo makes the step a `gap` naming it.
 *
 * @param {{ cells: { agentOnData: { ref: string } } }} benchmark
 * @param {{ status: number, reason: string }} command
 * @param {readonly { title: string, status: 'passed' | 'failed' | 'skipped' | 'todo' }[]} results
 */
export function agentOnDataOutcome(benchmark, command, results) {
  if (command.status !== 0) return { status: 'failed', reason: command.reason };
  const { ref } = benchmark.cells.agentOnData;
  const named = results.filter((result) => result.title === ref);
  if (named.length === 0) return { status: 'gap', reason: `no test is titled '${ref}'` };
  const unsettled = named.find((result) => result.status !== 'passed');
  if (unsettled !== undefined) {
    return { status: 'gap', reason: `the test '${ref}' is ${unsettled.status}, not passed` };
  }
  return { status: 'ok', reason: `${String(results.length)} tests settled; '${ref}' passed` };
}

/** The job summary: one row per app, one column per lane cell, and every reason. */
export function renderLaneSummary(results) {
  const header = ['App', ...LANE_CELLS];
  const rows = results.map(({ benchmark, verdicts }) => [
    benchmark.id,
    ...LANE_CELLS.map((cell) => (verdicts[cell].verdict === 'ok' ? '✅' : '❌')),
  ]);
  const reasons = results.flatMap(({ benchmark, verdicts }) =>
    LANE_CELLS.flatMap((cell) =>
      verdicts[cell].reasons.map((reason) => `- ${benchmark.id}.${cell}: ${reason.split('\n')[0]}`),
    ),
  );
  return [
    '## apps-e2e',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    ...reasons,
    '',
  ].join('\n');
}

/**
 * A scenario's line of the job summary.
 *
 * @param {string} id @param {{ status: 'ok' | 'failed' | 'gap', reason: string }} outcome
 */
export function renderScenarioSummary(id, outcome) {
  const mark = { ok: '✅', failed: '❌', gap: '⏭️' }[outcome.status];
  return `${mark} scenario ${id}: ${outcome.reason.split('\n')[0]}\n`;
}

/** @param {string} id @param {Map<string, import('./lane.d.mts').StepOutcome>} outcomes @param {string} step @param {import('./lane.d.mts').StepOutcome} outcome */
export function record(id, outcomes, step, outcome) {
  outcomes.set(step, outcome);
  console.log(
    `== ${id} ${step}: ${outcome.status}${outcome.status === 'ok' ? '' : ` (${outcome.reason.split('\n')[0]})`}`,
  );
}
