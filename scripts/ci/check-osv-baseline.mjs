#!/usr/bin/env node
// osv-scanner gate (engineering audit F-03). Usage: check-osv-baseline.mjs <osv.json> <baseline.json>
//
// With --warn-only (pull requests that do not touch the lockfile or the baseline) every problem is
// a ::warning and the exit code is 0, so outside state (a new advisory, an osv.dev change) cannot
// block unrelated PRs; push to main stays strict.
//
// Fails on a vulnerability that is not in the committed baseline (new finding) and on a baseline
// entry that no longer matches a finding (stale: delete it). The baseline can therefore only
// shrink; it is never a way to silence a new advisory without a reviewed edit to the file.
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ results?: { packages?: { package: { name: string, version: string }, vulnerabilities?: { id: string }[] }[] }[] }} OsvReport
 * @typedef {{ findings: string[] }} Baseline
 * @typedef {{ added: string[], stale: string[] }} Comparison
 */

/**
 * Every `package@version ID` pair osv-scanner reported.
 * @param {OsvReport} report
 * @returns {Set<string>}
 */
export function findings(report) {
  const out = new Set();
  for (const result of report.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        out.add(`${pkg.package.name}@${pkg.package.version} ${vuln.id}`);
      }
    }
  }
  return out;
}

/**
 * @param {OsvReport} report
 * @param {Baseline} baseline
 * @returns {Comparison}
 */
export function compare(report, baseline) {
  const found = findings(report);
  const known = new Set(baseline.findings);
  return {
    added: [...found].filter((f) => !known.has(f)).sort(),
    stale: [...known].filter((f) => !found.has(f)).sort(),
  };
}

/**
 * Annotations and exit code for a comparison.
 * @param {Comparison} comparison
 * @param {string} baselinePath
 * @param {boolean} warnOnly
 * @returns {{ lines: string[], code: number }}
 */
export function verdict({ added, stale }, baselinePath, warnOnly) {
  const level = warnOnly ? 'warning' : 'error';
  const lines = [
    ...added.map((f) => `::${level} title=New vulnerability::${f} is not in ${baselinePath}`),
    ...stale.map(
      (f) =>
        `::${level} title=Stale baseline entry::${f} no longer reported; delete it from ${baselinePath}`,
    ),
  ];
  return { lines, code: !warnOnly && lines.length > 0 ? 1 : 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [reportPath, baselinePath, flag] = process.argv.slice(2);
  if (reportPath === undefined || baselinePath === undefined) {
    console.error('usage: check-osv-baseline.mjs <osv.json> <baseline.json> [--warn-only]');
    process.exit(2);
  }
  const { lines, code } = verdict(
    compare(
      JSON.parse(readFileSync(reportPath, 'utf8')),
      JSON.parse(readFileSync(baselinePath, 'utf8')),
    ),
    baselinePath,
    flag === '--warn-only',
  );
  for (const line of lines) console.error(line);
  if (code === 0) console.log('osv-scanner: nothing blocking.');
  process.exit(code);
}
