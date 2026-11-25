#!/usr/bin/env node
/**
 * The dependency-cruiser half of `pnpm architecture:check`: ONE run of the real config over `apps`,
 * `packages` and `use-cases`, with the violations listed in `.dependency-cruiser-known-violations.json`
 * ignored, that fails on
 *
 * - a violation the baseline does not list — exactly what `depcruise --ignore-known` fails on,
 *   reported in dependency-cruiser's own `err` format;
 * - a baseline entry the tree no longer has. The baseline only shrinks (F-15): a fixed violation is
 *   removed from the file, with the command below, so it cannot quietly come back.
 *
 * The second check used to be a test (tests/architecture-rules.test.ts, "the known-violations
 * baseline only shrinks") that cruised the whole tree a second time, about 20 s, on every change
 * the root `tests` project saw. Here it costs nothing: dependency-cruiser keeps an ignored
 * violation in its report, with the severity `ignore`, so the same run answers both questions.
 * That the baseline's counts stay within their committed ceilings depends on the file alone and
 * is still a test (tests/architecture-rules.test.ts, the `tests-architecture` project).
 */
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const KNOWN_VIOLATIONS = '.dependency-cruiser-known-violations.json';

export const REGENERATE_BASELINE =
  'pnpm exec depcruise --config dependency-cruiser.config.mjs --output-type baseline apps packages use-cases > .dependency-cruiser-known-violations.json';

/**
 * @typedef {{ rule: { name: string; severity: string }; from: string; to: string }} Violation
 */

/** @param {{ rule: { name: string }; from: string; to: string }} violation */
export const violationKey = (violation) =>
  `${violation.rule.name}: ${violation.from} -> ${violation.to}`;

/**
 * What one dependency-cruiser run with `--ignore-known` says about the tree and the baseline.
 *
 * @param {readonly Violation[]} violations the run's `summary.violations`
 * @param {readonly { rule: { name: string }; from: string; to: string }[]} known the baseline
 * @returns {{ unlisted: string[]; stale: string[] }} `unlisted` — violations the baseline does not
 *   list (any severity but `ignore`); `stale` — baseline entries the run no longer found
 */
export function compareWithBaseline(violations, known) {
  const ignored = new Set(
    violations.filter((violation) => violation.rule.severity === 'ignore').map(violationKey),
  );
  return {
    unlisted: violations
      .filter((violation) => violation.rule.severity !== 'ignore')
      .map(violationKey)
      .sort(),
    stale: known
      .map(violationKey)
      .filter((key) => !ignored.has(key))
      .sort(),
  };
}

/** @param {unknown} value @param {string} what @returns {any} */
function requireObject(value, what) {
  if (value === null || typeof value !== 'object') throw new Error(`${what} is not an object`);
  return value;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cruiser = path.join(repoRoot, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
  const run = spawnSync(
    process.execPath,
    [
      cruiser,
      '--config',
      'dependency-cruiser.config.mjs',
      '--ignore-known',
      KNOWN_VIOLATIONS,
      '--output-type',
      'json',
      'apps',
      'packages',
      'use-cases',
    ],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (run.error !== undefined || run.stdout.trim() === '') {
    console.error(`dependency-cruiser produced no report: ${run.error?.message ?? run.stderr}`);
    return 1;
  }
  const result = requireObject(JSON.parse(run.stdout), 'the dependency-cruiser report');
  const summary = requireObject(result.summary, 'the report summary');
  if (!Array.isArray(summary.violations)) throw new Error('the report has no violations list');
  const known = JSON.parse(readFileSync(path.join(repoRoot, KNOWN_VIOLATIONS), 'utf8'));
  if (!Array.isArray(known)) throw new Error(`${KNOWN_VIOLATIONS} is not a list`);

  const { unlisted, stale } = compareWithBaseline(summary.violations, known);
  let failed = false;
  // dependency-cruiser's own verdict on the run — the count of error-severity violations it did not
  // ignore, which is the exit code of `depcruise --ignore-known` with its default `err` output (with
  // `--output-type json` it exits 0, so the summary is read) — reported in that same `err` format.
  // A warning is printed and does not fail, as there.
  const errors = typeof summary.error === 'number' ? summary.error : Number.NaN;
  if (errors !== 0 || run.status !== 0 || unlisted.length > 0) {
    const { format } = await import('dependency-cruiser');
    const { output } = await format(result, { outputType: 'err' });
    console.error(output);
    failed = errors !== 0 || run.status !== 0;
  }
  if (stale.length > 0) {
    console.error(
      `${KNOWN_VIOLATIONS} lists ${String(stale.length)} violation(s) the tree no longer has:\n` +
        stale.map((key) => `  ${key}`).join('\n') +
        `\nThe baseline only shrinks: regenerate it (${REGENERATE_BASELINE}) and lower the ` +
        'ceiling in tests/architecture-rules.test.ts.',
    );
    failed = true;
  }
  if (!failed) {
    console.log(
      `dependency-cruiser: no violation outside ${KNOWN_VIOLATIONS}, and every entry in it still ` +
        `exists (${String(known.length)} known, ${String(summary.totalCruised)} modules cruised)`,
    );
  }
  return failed ? 1 : 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
