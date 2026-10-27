#!/usr/bin/env node
// Known-violation baseline gate: `eslint-suppressions.json` may only shrink.
//
// ESLint itself fails a run when a file produces MORE violations of a suppressed rule than the
// baseline records, and when the baseline records violations that no longer occur (run
// `eslint --prune-suppressions`). What ESLint cannot see is the baseline file being regenerated
// with a larger count in the same diff, so CI compares it with the target branch:
//
//   node scripts/check-lint-baseline.mjs <base eslint-suppressions.json> <head eslint-suppressions.json>
//
// Exit 1 lists every (file, rule) whose count is new or higher than on the base.
import { readFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';

/** @typedef {Record<string, Record<string, { count: number }>>} Baseline */

/**
 * @param {Baseline} base
 * @param {Baseline} head
 * @returns {string[]}
 */
export function growth(base, head) {
  const grown = [];
  for (const [file, rules] of Object.entries(head)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const before = base[file]?.[rule]?.count ?? 0;
      if (count > before) grown.push(`${file}  ${rule}  ${before} -> ${count}`);
    }
  }
  return grown;
}

const [basePath, headPath] = process.argv.slice(2);
if (basePath && headPath) {
  const grown = growth(
    JSON.parse(readFileSync(basePath, 'utf8')),
    JSON.parse(readFileSync(headPath, 'utf8')),
  );
  if (grown.length > 0) {
    console.error('eslint-suppressions.json grew; fix the violation instead:');
    for (const line of grown) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log('eslint-suppressions.json did not grow.');
}
