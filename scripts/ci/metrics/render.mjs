// Markdown rendering of a CI metrics report (`aggregate.mjs`). Pure: report in, text out.

/**
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function duration(seconds) {
  if (seconds === null || seconds === undefined) return '–';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes === 0 ? `${rest}s` : `${minutes}m${String(rest).padStart(2, '0')}s`;
}

/** @param {number} value */
const usd = (value) => `$${value.toFixed(2)}`;

/**
 * A workflow name cut to 60 characters: Dependabot names its dynamic workflows after every package
 * it updates, and a table cell several hundred characters wide hides the rest of the row.
 * @param {string} name
 */
export const short = (name) => (name.length > 60 ? `${name.slice(0, 59)}…` : name);

/**
 * @param {string} value
 * @returns {string}
 */
const cell = (value) => value.replaceAll('|', '\\|');

/**
 * @param {readonly string[]} header
 * @param {ReadonlyArray<ReadonlyArray<string | number>>} rows
 * @returns {string}
 */
export function table(header, rows) {
  const line = (/** @type {ReadonlyArray<string | number>} */ values) =>
    `| ${values.map((value) => cell(String(value))).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/**
 * @param {import('./aggregate.mjs').Report} report
 * @param {{jobRows?: number}} [options]
 * @returns {string}
 */
export function renderMarkdown(report, options = {}) {
  const jobRows = options.jobRows ?? 40;
  const { window: w, totals } = report;
  const sections = [
    `### CI metrics — ${report.repo}, ${w.from.slice(0, 10)} → ${w.to.slice(0, 10)} (${w.days} days)`,
    `${totals.runs} completed runs, ${totals.jobs} jobs that ran, ${totals.minutes} billed minutes ` +
      `(${totals.minutesPerWeek}/week), estimated ${usd(totals.usd)} (${usd(totals.usdPerWeek)}/week).`,
    '#### By runner group',
    table(
      ['runner group', 'minutes', 'minutes/week', 'est. USD', 'est. USD/week'],
      report.byRunnerGroup.map((row) => [
        row.runnerGroup,
        row.minutes,
        row.minutesPerWeek,
        usd(row.usd),
        usd(row.usdPerWeek),
      ]),
    ),
    '#### By runner class',
    table(
      ['runner class', 'USD/min', 'jobs', 'minutes', 'minutes/week', 'est. USD'],
      report.byRunnerClass.map((row) => [
        row.runnerClass,
        row.usdPerMinute.toFixed(4),
        row.jobs,
        row.minutes,
        row.minutesPerWeek,
        usd(row.usd),
      ]),
    ),
    '#### Pull request wall clock (CI workflow, human PRs, longest finished run per pushed head)',
    table(
      ['PR kind', 'heads', 'PRs', 'p50', 'p90'],
      [
        [
          'docs-only',
          report.prWall.docsOnly.heads,
          report.prWall.docsOnly.pullRequests,
          duration(report.prWall.docsOnly.p50Seconds),
          duration(report.prWall.docsOnly.p90Seconds),
        ],
        [
          'code',
          report.prWall.code.heads,
          report.prWall.code.pullRequests,
          duration(report.prWall.code.p50Seconds),
          duration(report.prWall.code.p90Seconds),
        ],
      ],
    ),
    '#### By workflow × event',
    table(
      [
        'workflow',
        'event',
        'runs',
        'cancelled runs',
        'minutes',
        'cancelled min',
        'est. USD',
        'wall p50',
        'wall p90',
      ],
      report.byWorkflowEvent.map((row) => [
        short(row.workflow),
        row.event,
        row.runs,
        row.cancelledRuns,
        row.minutes,
        row.cancelledMinutes,
        usd(row.usd),
        duration(row.wallP50Seconds),
        duration(row.wallP90Seconds),
      ]),
    ),
    `#### By job (top ${jobRows} by minutes)`,
    table(
      ['workflow', 'event', 'job', 'runner class', 'count', 'minutes', 'est. USD', 'p50', 'p90'],
      report.byJob
        .slice(0, jobRows)
        .map((row) => [
          short(row.workflow),
          row.event,
          row.job,
          row.runnerClass,
          row.count,
          row.minutes,
          usd(row.usd),
          duration(row.p50Seconds),
          duration(row.p90Seconds),
        ]),
    ),
    '#### Pull request vs merge queue, and who opened the PR',
    table(
      ['event', 'origin', 'runs', 'PRs', 'minutes', 'est. USD'],
      report.byOrigin.map((row) => [
        row.event,
        row.origin,
        row.runs,
        row.pullRequests,
        row.minutes,
        usd(row.usd),
      ]),
    ),
    `Merge queue: ${report.mergeGroup.minutes} minutes, of which ${report.mergeGroup.duplicateMinutes} ` +
      `(${usd(report.mergeGroup.duplicateUsd)}) re-ran a workflow × job that had already run on the same PR.`,
    table(
      ['workflow', 'duplicate minutes', 'est. USD'],
      report.mergeGroup.byWorkflow.map((row) => [
        short(row.workflow),
        row.duplicateMinutes,
        usd(row.usd),
      ]),
    ),
    `Same-SHA repeats: ${report.prRepeats.extraRuns} pull request runs re-tested a head SHA that ` +
      `already had a run of the same workflow (${report.prRepeats.shas} SHAs), ` +
      `${report.prRepeats.minutes} minutes (${usd(report.prRepeats.usd)}). Later runs by trigger:`,
    table(
      ['triggered by', 'runs', 'minutes'],
      report.prRepeats.laterRunsByTrigger.map((row) => [row.trigger, row.runs, row.minutes]),
    ),
    `Cancelled jobs: ${report.cancelled.jobs} jobs, ${report.cancelled.minutes} minutes (${usd(report.cancelled.usd)}).`,
  ];
  return `${sections.join('\n\n')}\n`;
}

/**
 * @param {{offending: import('./budget.mjs').BudgetRow[], missing: import('./budget.mjs').BudgetRow[]}} result
 * @returns {string}
 */
export function renderCheck(result) {
  const lines = [];
  if (result.offending.length === 0)
    lines.push('CI budget: every budgeted row is within its ceiling.');
  else {
    lines.push(`CI budget exceeded on ${result.offending.length} row(s):`);
    lines.push(
      table(
        ['kind', 'row', 'actual', 'ceiling'],
        result.offending.map((row) => [row.kind, row.key, row.actual ?? '–', row.limit]),
      ),
    );
  }
  if (result.missing.length > 0) {
    lines.push(
      `No data in the window for ${result.missing.length} budgeted row(s) (not a failure):`,
    );
    lines.push(
      table(
        ['kind', 'row', 'ceiling'],
        result.missing.map((row) => [row.kind, row.key, row.limit]),
      ),
    );
  }
  return `${lines.join('\n\n')}\n`;
}
