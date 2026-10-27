#!/usr/bin/env node
// Coverage ratchet (W4-4): a configured coverage floor can never go down.
//
// Vitest already fails a suite below its floor. What it cannot see is a floor lowered to make a
// change green. When COVERAGE_BASE_REV names a revision (CI: the fetched pull request base), this
// fails if any floor in the config is lower than the same floor there; with no base (the exported
// OSS tree, a local run) that comparison is skipped with a notice. A floor trailing the measured
// value by more than TOLERANCE points only prints a `::warning::` with the value to raise it to.
// It fails closed when the config or the coverage summary cannot be read.
//
//   node scripts/check-coverage-ratchet.mjs <vitest coverage config> <coverage-summary.json>
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Points a floor may trail the measured value before a warning asks for it to be raised. */
export const TOLERANCE = 5;
export const METRICS = /** @type {const} */ (['lines', 'functions', 'statements', 'branches']);

/**
 * @param {string} metric
 * @param {number} floor the configured threshold
 * @param {number} measured the measured percentage
 * @param {number | undefined} base the same floor on the pull request's base, when known
 * @returns {{ failure: string | null; warning: string | null }} a failure fails the job; a
 *   warning only asks for the floor to be raised
 */
export function verdict(metric, floor, measured, base) {
  if (base !== undefined && floor < base) {
    return {
      failure: `${metric} floor was lowered from ${base}% to ${floor}%; floors only go up.`,
      warning: null,
    };
  }
  if (measured < floor) {
    return {
      failure: `${metric} coverage is ${measured}%, below the floor ${floor}%; add tests (never lower the floor).`,
      warning: null,
    };
  }
  if (measured - floor > TOLERANCE) {
    const raise = Math.floor(measured) - TOLERANCE + 2;
    return {
      failure: null,
      warning: `${metric} floor is ${floor}% but ${measured}% is measured; raise it to about ${raise}.`,
    };
  }
  return { failure: null, warning: null };
}

/**
 * The four floors of the `thresholds` block of a vitest coverage config.
 * @param {string} source
 * @returns {Record<(typeof METRICS)[number], number>}
 */
export function parseFloors(source) {
  const block = /thresholds:\s*\{([^}]*)\}/u.exec(source)?.[1];
  if (block === undefined) throw new Error('no `thresholds` block found in the coverage config');
  const floors = /** @type {Record<string, number>} */ ({});
  for (const metric of METRICS) {
    const value = new RegExp(String.raw`^\s*${metric}:\s*(\d+(?:\.\d+)?)\s*,`, 'mu').exec(
      block,
    )?.[1];
    if (value === undefined) throw new Error(`no \`${metric}\` floor in the coverage config`);
    floors[metric] = Number(value);
  }
  return /** @type {Record<(typeof METRICS)[number], number>} */ (floors);
}

/**
 * @param {unknown} summary parsed `coverage-summary.json`
 * @returns {Record<(typeof METRICS)[number], number>}
 */
export function parseMeasured(summary) {
  const total = /** @type {Record<string, { pct?: unknown } | undefined> | undefined} */ (
    /** @type {{ total?: never }} */ (summary ?? {}).total
  );
  const measured = /** @type {Record<string, number>} */ ({});
  for (const metric of METRICS) {
    const pct = total?.[metric]?.pct;
    if (typeof pct !== 'number') throw new Error(`no measured \`${metric}\` in the summary`);
    measured[metric] = pct;
  }
  return /** @type {Record<(typeof METRICS)[number], number>} */ (measured);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [config, summary] = process.argv.slice(2);
  if (config === undefined || summary === undefined) {
    console.error('usage: check-coverage-ratchet.mjs <coverage config> <coverage-summary.json>');
    process.exit(2);
  }
  const floors = parseFloors(readFileSync(config, 'utf8'));
  const measured = parseMeasured(JSON.parse(readFileSync(summary, 'utf8')));
  const rev = process.env['COVERAGE_BASE_REV'];
  /** @type {Record<(typeof METRICS)[number], number> | undefined} */
  let base;
  if (rev === undefined || rev === '' || rev.startsWith('-')) {
    console.log('::notice::no base revision: skipping the floors-only-go-up comparison.');
  } else {
    base = parseFloors(execFileSync('git', ['show', `${rev}:${config}`], { encoding: 'utf8' }));
  }
  const verdicts = METRICS.map((metric) =>
    verdict(metric, floors[metric], measured[metric], base?.[metric]),
  );
  for (const { warning } of verdicts)
    if (warning !== null) console.log(`::warning::${config}: ${warning}`);
  const failures = verdicts.flatMap(({ failure }) => (failure === null ? [] : [failure]));
  if (failures.length > 0) {
    console.error([`${config}:`, ...failures.map((failure) => `- ${failure}`)].join('\n'));
    process.exit(1);
  }
  console.log(`${config}: no floor lowered or under the measured coverage.`);
}
