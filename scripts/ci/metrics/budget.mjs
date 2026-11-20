// The CI budget: a machine-readable JSON block inside docs/40-operate/operations/ci-budget.md, between
//
//   <!-- ci-budget:begin -->
//   ```json
//   { ... }
//   ```
//   <!-- ci-budget:end -->
//
// and the check that holds a report (`aggregate.mjs`) to it. Every limit is a ceiling; a row is
// "offending" when its measured value is above the ceiling. A budgeted row with no data in the
// window (a job renamed or not run) is reported as missing but does not fail the check, because
// absence of runs is not a budget overrun.

import { RUNNER_GROUPS } from './aggregate.mjs';

const BLOCK = /<!-- ci-budget:begin -->\s*```json\s*([\s\S]*?)```\s*<!-- ci-budget:end -->/u;

/**
 * @typedef {object} JobBudget
 * @property {string} workflow
 * @property {string} job
 * @property {string} [event] omitted: every event
 * @property {number} p90Seconds
 */

/**
 * @typedef {object} WallBudget
 * @property {string} workflow
 * @property {string} event
 * @property {'p50' | 'p90'} stat
 * @property {number} maxSeconds
 */

/**
 * @typedef {object} Budget
 * @property {Record<string, number>} minutesPerWeek keyed by runner group or runner class
 * @property {JobBudget[]} jobP90Seconds
 * @property {WallBudget[]} wallSeconds
 * @property {{docsOnly?: number, code?: number}} prWallP50Seconds
 */

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {number}
 */
function ceiling(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`ci-budget: ${where} must be a non-negative number`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function text(value, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ci-budget: ${where} must be a non-empty string`);
  }
  return value;
}

/**
 * Extract and validate the budget block of a markdown document.
 * @param {string} markdown
 * @returns {Budget}
 */
export function parseBudget(markdown) {
  const match = BLOCK.exec(markdown);
  if (!match)
    throw new Error(
      'ci-budget: no <!-- ci-budget:begin --> ```json … ``` <!-- ci-budget:end --> block',
    );
  /** @type {any} */
  const raw = JSON.parse(/** @type {string} */ (match[1]));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ci-budget: the block must be a JSON object');
  }
  const known = new Set(['minutesPerWeek', 'jobP90Seconds', 'wallSeconds', 'prWallP50Seconds']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`ci-budget: unknown key "${key}"`);
  }
  /** @type {Record<string, number>} */
  const minutesPerWeek = {};
  for (const [key, value] of Object.entries(raw.minutesPerWeek ?? {})) {
    minutesPerWeek[key] = ceiling(value, `minutesPerWeek.${key}`);
  }
  const jobP90Seconds = (Array.isArray(raw.jobP90Seconds) ? raw.jobP90Seconds : []).map(
    (/** @type {any} */ entry, /** @type {number} */ index) => ({
      workflow: text(entry?.workflow, `jobP90Seconds[${index}].workflow`),
      job: text(entry?.job, `jobP90Seconds[${index}].job`),
      ...(entry?.event === undefined
        ? {}
        : { event: text(entry.event, `jobP90Seconds[${index}].event`) }),
      p90Seconds: ceiling(entry?.p90Seconds, `jobP90Seconds[${index}].p90Seconds`),
    }),
  );
  const wallSeconds = (Array.isArray(raw.wallSeconds) ? raw.wallSeconds : []).map(
    (/** @type {any} */ entry, /** @type {number} */ index) => {
      if (entry?.stat !== 'p50' && entry?.stat !== 'p90') {
        throw new Error(`ci-budget: wallSeconds[${index}].stat must be "p50" or "p90"`);
      }
      return {
        workflow: text(entry.workflow, `wallSeconds[${index}].workflow`),
        event: text(entry.event, `wallSeconds[${index}].event`),
        stat: /** @type {'p50' | 'p90'} */ (entry.stat),
        maxSeconds: ceiling(entry.maxSeconds, `wallSeconds[${index}].maxSeconds`),
      };
    },
  );
  /** @type {{docsOnly?: number, code?: number}} */
  const prWallP50Seconds = {};
  for (const [key, value] of Object.entries(raw.prWallP50Seconds ?? {})) {
    if (key !== 'docsOnly' && key !== 'code')
      throw new Error(`ci-budget: unknown prWallP50Seconds.${key}`);
    prWallP50Seconds[key] = ceiling(value, `prWallP50Seconds.${key}`);
  }
  return { minutesPerWeek, jobP90Seconds, wallSeconds, prWallP50Seconds };
}

/**
 * @typedef {object} BudgetRow
 * @property {string} kind
 * @property {string} key
 * @property {number | null} actual
 * @property {number} limit
 */

/**
 * Hold a report to a budget.
 * @param {import('./aggregate.mjs').Report} report
 * @param {Budget} budget
 * @returns {{offending: BudgetRow[], missing: BudgetRow[]}}
 */
export function checkBudget(report, budget) {
  /** @type {BudgetRow[]} */
  const offending = [];
  /** @type {BudgetRow[]} */
  const missing = [];
  /**
   * @param {string} kind
   * @param {string} key
   * @param {number | null | undefined} actual
   * @param {number} limit
   */
  const hold = (kind, key, actual, limit) => {
    if (actual === null || actual === undefined) missing.push({ kind, key, actual: null, limit });
    else if (actual > limit) offending.push({ kind, key, actual, limit });
  };

  for (const [key, limit] of Object.entries(budget.minutesPerWeek)) {
    const actual = RUNNER_GROUPS.includes(key)
      ? report.byRunnerGroup.find((row) => row.runnerGroup === key)?.minutesPerWeek
      : (report.byRunnerClass.find((row) => row.runnerClass === key)?.minutesPerWeek ?? 0);
    hold('minutesPerWeek', key, actual ?? 0, limit);
  }

  for (const entry of budget.jobP90Seconds) {
    const rows = report.byJob.filter(
      (row) =>
        row.workflow === entry.workflow &&
        row.job === entry.job &&
        (entry.event === undefined || row.event === entry.event) &&
        row.p90Seconds !== null,
    );
    const label = `${entry.workflow} / ${entry.job}${entry.event ? ` (${entry.event})` : ''}`;
    if (rows.length === 0) hold('jobP90Seconds', label, null, entry.p90Seconds);
    for (const row of rows) {
      hold(
        'jobP90Seconds',
        `${entry.workflow} / ${row.job} (${row.event}, ${row.runnerClass})`,
        row.p90Seconds,
        entry.p90Seconds,
      );
    }
  }

  for (const entry of budget.wallSeconds) {
    const row = report.byWorkflowEvent.find(
      (r) => r.workflow === entry.workflow && r.event === entry.event,
    );
    const actual = entry.stat === 'p50' ? row?.wallP50Seconds : row?.wallP90Seconds;
    hold(
      'wallSeconds',
      `${entry.workflow} (${entry.event}) ${entry.stat}`,
      actual,
      entry.maxSeconds,
    );
  }

  for (const [key, limit] of Object.entries(budget.prWallP50Seconds)) {
    const stats = key === 'docsOnly' ? report.prWall.docsOnly : report.prWall.code;
    hold('prWallP50Seconds', key, stats.p50Seconds, /** @type {number} */ (limit));
  }

  return { offending, missing };
}
