/**
 * @typedef {import('./run.d.mts').Row} Row
 */
/* global console */
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { JourneyFailure } from '../journey/harness.mjs';
import { scrub } from '../journey/run.mjs';
import { MAX_WHAT, MAX_DETAIL_LINES } from './run-config.mjs';

/** @param {string} text @param {number} [max] */
function cell(text, max = MAX_WHAT) {
  const one = text.replace(/\s+/gu, ' ').trim().replace(/\|/gu, '\\|');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * 1 when a claim failed or was skipped: a skipped claim (no key) is not a pass. `n/a` rows (written
 * for another shell, or needing something this machine lacks) are not counted against the run.
 *
 * @param {readonly Row[]} rows
 */
export function exitCodeOf(rows) {
  return rows.some((row) => row.result.startsWith('FAIL') || row.result.startsWith('skipped'))
    ? 1
    : 0;
}

/**
 * The summary table, and under it what each failing claim printed.
 *
 * @param {readonly Row[]} rows @param {readonly string[]} notes @param {string} [title]
 */
export function summaryMarkdown(rows, notes, title = 'Docs claims') {
  const failing = rows.filter((row) => row.result.startsWith('FAIL'));
  const skipped = rows.filter((row) => row.result.startsWith('skipped'));
  const unavailable = rows.filter((row) => row.result.startsWith('n/a'));
  /** @type {Record<string, number>} */
  const states = {};
  for (const row of rows) states[row.state] = (states[row.state] ?? 0) + 1;
  const counts = Object.entries(states)
    .map(([state, count]) => `${String(count)} ${state}`)
    .join(', ');
  return [
    `### ${title}: ${String(rows.length)} claims (${counts}), ${String(failing.length)} failing, ${String(skipped.length)} skipped, ${String(unavailable.length)} n/a`,
    '',
    ...notes.map((note) => `${note}\n`),
    '| page:line | state | command or file | result | duration |',
    '| --- | --- | --- | --- | ---: |',
    ...rows.map(
      (row) =>
        `| ${cell(row.where, 80)} | ${row.state} | ${cell(row.what)} | ${cell(row.result, 70)} | ${
          row.seconds === undefined ? '' : `${row.seconds.toFixed(1)} s`
        } |`,
    ),
    '',
    ...failing.flatMap((row) => [
      `#### ${row.where}`,
      '',
      '```text',
      scrub((row.detail ?? row.result).split('\n').slice(0, MAX_DETAIL_LINES).join('\n')),
      '```',
      '',
    ]),
  ].join('\n');
}

/**
 * Writes `summary.md` and `results.json`. If either write fails (a full disk, #1098), both files are
 * removed so the report reads the lane as missing, never as a truncated set that looks like a pass.
 *
 * @param {readonly Row[]} rows @param {string[]} notes @param {string} work
 */
export function save(rows, notes, work) {
  const markdown = summaryMarkdown(rows, notes);
  const files = /** @type {const} */ ([
    ['summary.md', markdown],
    ['results.json', `${JSON.stringify(rows, null, 2)}\n`],
  ]);
  for (const [name, text] of files) {
    try {
      writeFileSync(path.join(work, name), text);
    } catch (error) {
      for (const [written] of files) {
        rmSync(path.join(work, written), { recursive: true, force: true });
      }
      throw new JourneyFailure(
        `could not write ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return markdown;
}

/** @param {Row[]} rows @param {string[]} notes @param {string} work */
export function report(rows, notes, work) {
  const markdown = save(rows, notes, work);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, `${markdown}\n`);
  console.log(markdown.split('\n').slice(0, 3).join('\n'));
}
