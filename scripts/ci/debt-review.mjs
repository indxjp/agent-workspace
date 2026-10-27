#!/usr/bin/env node
// Quarterly debt review (engineering audit W4-3): prints the markdown body of the review issue,
// the current size of every baseline that may only shrink. Node stdlib and `git ls-files` only.
//
//   node scripts/ci/debt-review.mjs [--date YYYY-MM-DD]
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readHead, scan } from '../stories/check.mts';

/** @param {string} date YYYY-MM-DD @returns {string} e.g. `2026-Q4` */
export function quarterOf(date) {
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

/** @param {unknown} suppressions parsed eslint-suppressions.json @returns {number} */
export function countSuppressions(suppressions) {
  let n = 0;
  for (const rules of Object.values(
    /** @type {Record<string, Record<string, {count: number}>>} */ (suppressions),
  )) {
    for (const rule of Object.values(rules)) n += rule.count;
  }
  return n;
}

/** Baseline entries that name a review date, soonest first. @param {Record<string, string>} justifications */
export function reviewDates(justifications) {
  return Object.entries(justifications)
    .flatMap(([entry, text]) => {
      const m = /review by (\d{4}-\d{2}-\d{2})/.exec(text);
      return m?.[1] ? [{ entry, date: m[1] }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** @param {string[]} adrTexts @returns {number} ADRs whose `Status:` line says proposed */
export function countProposedAdrs(adrTexts) {
  return adrTexts.filter((t) => /^Status:.*proposed/im.test(t)).length;
}

/**
 * @param {{ date: string, depcruise: number, suppressions: number, complexityCeiling: string,
 *   storeAllowlist: number, storageLimitsAllowlist: number, catalogFakesAllowlist: number, routeBoundaryAllowlist: number, osv: string[], osvReviews: { entry: string, date: string }[],
 *   ponytail: number, itFails: number, storyGaps: number, storageBridges: number,
 *   proposedAdrs: number, baselineFile: string }} m
 */
export function render(m) {
  const overdue = m.osvReviews.filter((r) => r.date <= m.date);
  return `<!-- debt-review:${quarterOf(m.date)} -->
Quarterly debt review for ${quarterOf(m.date)} (measured ${m.date}). Every list below may only
shrink. Procedure: docs/operations/debt-review.md.
Compare each number with the previous review issue, then tick the boxes.

| Baseline | Now |
| --- | --- |
| dependency-cruiser known violations | ${m.depcruise} |
| ESLint suppressions (sum of counts) | ${m.suppressions} |
| complexity ceiling (\`eslint.config.mjs\`) | ${m.complexityCeiling} |
| store-conformance allowlist entries | ${m.storeAllowlist} |
| storage-limits allowlist entries | ${m.storageLimitsAllowlist} |
| catalog-fakes allowlist sites | ${m.catalogFakesAllowlist} |
| route-error-boundary allowlist entries | ${m.routeBoundaryAllowlist} |
| osv baseline findings | ${m.osv.length} |
| \`ponytail:\` shortcuts | ${m.ponytail} |
| \`it.fails\` characterization rows | ${m.itFails} |
| storage story gaps | ${m.storyGaps} |
| \`storage-bridge\` markers | ${m.storageBridges} |
| ADRs with status proposed | ${m.proposedAdrs} |
| newest metrics baseline | \`${m.baselineFile}\` |

${overdue.length > 0 ? `Overdue osv reviews: ${overdue.map((r) => `${r.entry} (${r.date})`).join(', ')}\n` : 'No osv review date has passed.\n'}
- [ ] Each baseline above: delete at least the entries already fixed; none grew.
- [ ] Coverage floors (\`vitest*.coverage.config.ts\`): raise to the measured value.
- [ ] osv entries with a review date: re-decide or remove.
- [ ] \`node scripts/metrics/baseline.mjs\`: commit the new file and compare with the last.
- [ ] \`ponytail:\` shortcuts and proposed ADRs: pay, accept or reject each one.
- [ ] Decision ledger and formal findings status are current.
- [ ] Close this issue.
`;
}

/** Files that define the marker convention, so their mentions of it are not markers. */
const BRIDGE_DEFINITIONS = new Set([
  'ENGINEERING_GUIDELINES.md',
  'scripts/ci/debt-review.mjs',
  'tests/storage-bridges.test.ts',
  'tests/tooling/debt-review.test.ts',
]);

/**
 * A bridge marker names the issue that deletes it; any other line mentioning it is malformed.
 * @param {{ path: string, text: string }[]} files
 * @returns {{ bridges: Hit[], malformed: Hit[] }}
 * @typedef {{ path: string, line: number, text: string }} Hit
 */
export function findBridges(files) {
  /** @type {Hit[]} */ const bridges = [];
  /** @type {Hit[]} */ const malformed = [];
  for (const { path, text } of files) {
    text.split('\n').forEach((raw, i) => {
      if (!/storage-bridge\b/.test(raw)) return;
      const hit = { path, line: i + 1, text: raw.trim() };
      (/storage-bridge\(#\d+\): \S/.test(raw) ? bridges : malformed).push(hit);
    });
  }
  return { bridges, malformed };
}

/** What the fitness test fails on: malformed markers, plus every marker once none may remain. */
export function bridgeViolations(
  /** @type {{ bridges: Hit[], malformed: Hit[] }} */ { bridges, malformed },
  /** @type {boolean} */ mayRemain,
) {
  return mayRemain ? malformed : [...malformed, ...bridges];
}

/** Text files tracked by git, minus the files that define the convention and the internal tree. */
export function trackedTextFiles() {
  return run('git', ['ls-files', '-z', '--', '.', ':(exclude)internal'])
    .split('\0')
    .filter((f) => f && !BRIDGE_DEFINITIONS.has(f))
    .flatMap((path) => {
      try {
        const text = readFileSync(path, 'utf8');
        return text.includes('\0') ? [] : [{ path, text }];
      } catch {
        return [];
      }
    });
}

/** @param {string} cmd @param {string[]} args */
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
/** @param {string} p */
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** @param {string} date */
export function measure(date) {
  const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean);
  const read = (/** @type {string} */ f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const sources = tracked.filter((f) => /\.(ts|tsx|mts|mjs)$/.test(f));
  const texts = sources.map(read);
  const osv = json('.osv-baseline.json');
  const baselines = tracked.filter((f) => /^docs\/metrics\/baseline-.*\.json$/.test(f)).sort();
  return {
    date,
    depcruise: json('.dependency-cruiser-known-violations.json').length,
    suppressions: countSuppressions(json('eslint-suppressions.json')),
    complexityCeiling:
      /complexity: \['error', \{ max: (\d+) \}\]/.exec(read('eslint.config.mjs'))?.[1] ?? 'unknown',
    storeAllowlist: json('tests/fitness/store-conformance-allowlist.json').length,
    storageLimitsAllowlist: Object.keys(json('tests/fitness/storage-limits-allowlist.json')).length,
    catalogFakesAllowlist: Object.values(json('tests/fitness/catalog-fakes-allowlist.json')).reduce(
      (n, count) => n + count,
      0,
    ),
    routeBoundaryAllowlist: json('tests/fitness/route-error-boundary-allowlist.json').length,
    osv: osv.findings,
    osvReviews: reviewDates(osv.justifications ?? {}),
    ponytail: texts.reduce((n, t) => n + (t.match(/\bponytail:/g) ?? []).length, 0),
    itFails: texts.reduce((n, t) => n + (t.match(/\bit\.fails\(/g) ?? []).length, 0),
    storyGaps: scan(readHead()).cells.filter((c) => !c.covered).length,
    storageBridges: findBridges(trackedTextFiles()).bridges.length,
    proposedAdrs: countProposedAdrs(tracked.filter((f) => /^docs\/adr\/.*\.md$/.test(f)).map(read)),
    baselineFile: baselines.at(-1) ?? 'none',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--date');
  const date = process.argv[i + 1] ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');
  console.log(render(measure(date)));
}
