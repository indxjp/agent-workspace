#!/usr/bin/env node
/* global console */
/**
 * The install-live verdict (issue #881): one table over every lane's `results.json`, and whether
 * the run is `pass`, `skipped` or `fail`. A lane whose file is missing is a `fail`, and a skipped
 * row is never a pass: it means the model key is not configured.
 *
 * `install-live-known.json` lists known failures, `{ lane, where, issue }`: a FAIL row of that lane
 * and `where` that is a product bug with its own issue. It reads `known failure (#N)` and still
 * fails the run, but is left out of the digest, so the install-live issue is not commented on again
 * for it. An entry whose row passes reads `stale known failure`. The digest is the sha256 of the
 * sorted other FAIL lines and missing lanes; the workflow comments only when it changes.
 *
 *   node tests/docs-claims/install-live-report.mjs <results directory> <lane>...
 *
 * The directory holds one `install-live-<lane>/results.json` per lane. The table goes to stdout,
 * `outcome=<verdict>` and `digest=<sha256>` to `$GITHUB_OUTPUT`.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_FAILURES = 40;
const KNOWN_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'install-live-known.json',
);

/** @typedef {{ lane: string, where: string, issue: number }} Known */

/**
 * @param {unknown} value the parsed `install-live-known.json`
 * @returns {Known[]}
 */
export function parseKnown(value) {
  if (!Array.isArray(value)) throw new Error('install-live-known.json must be an array');
  return value.map((/** @type {unknown} */ entry, index) => {
    const { lane, where, issue, ...rest } =
      typeof entry === 'object' && entry !== null
        ? /** @type {Record<string, unknown>} */ (entry)
        : {};
    if (
      typeof lane !== 'string' ||
      typeof where !== 'string' ||
      typeof issue !== 'number' ||
      !Number.isInteger(issue) ||
      issue < 1 ||
      Object.keys(rest).length > 0
    ) {
      throw new Error(
        `install-live-known.json[${String(index)}] must be exactly { lane, where, issue }`,
      );
    }
    return { lane, where, issue };
  });
}

/**
 * @param {readonly { name: string, rows: readonly { where: string, what: string, result: string }[] | null }[]} lanes
 * @param {readonly Known[]} [known]
 * @returns {{ outcome: 'pass' | 'skipped' | 'fail', markdown: string, digest: string }}
 */
export function verdict(lanes, known = []) {
  const count = (/** @type {readonly { result: string }[]} */ rows, /** @type {string} */ start) =>
    rows.filter((row) => row.result.startsWith(start)).length;
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const knownFailures = [];
  for (const lane of lanes) {
    for (const row of lane.rows ?? []) {
      if (!row.result.startsWith('FAIL')) continue;
      const entry = known.find((item) => item.lane === lane.name && item.where === row.where);
      const label = entry === undefined ? '' : `known failure (#${String(entry.issue)}): `;
      const line = `- ${lane.name}: ${row.where} (${row.what.slice(0, 80)}): ${label}${row.result}`;
      (entry === undefined ? failures : knownFailures).push(line);
    }
  }
  const stale = known.filter((entry) =>
    lanes.some(
      (lane) =>
        lane.name === entry.lane &&
        (lane.rows ?? []).some((row) => row.where === entry.where && row.result === 'pass'),
    ),
  );
  const missing = lanes.filter((lane) => lane.rows === null);
  const skipped = lanes.some((lane) => count(lane.rows ?? [], 'skipped') > 0);
  const needsKey = lanes.some(
    (lane) => count(lane.rows ?? [], 'skipped: needs ANTHROPIC_API_KEY') > 0,
  );
  /** @type {'pass' | 'skipped' | 'fail'} */
  const outcome =
    failures.length > 0 || knownFailures.length > 0 || missing.length > 0
      ? 'fail'
      : skipped
        ? 'skipped'
        : 'pass';
  const digest = createHash('sha256')
    .update([...failures, ...missing.map((lane) => `- ${lane.name}: missing`)].sort().join('\n'))
    .digest('hex');
  const markdown = [
    `## install-live: ${outcome}`,
    '',
    '| lane | claims | FAIL | skipped | n/a |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...lanes.map((lane) =>
      lane.rows === null
        ? `| ${lane.name} | missing | | | |`
        : `| ${lane.name} | ${String(lane.rows.length)} | ${String(count(lane.rows, 'FAIL'))} | ${String(count(lane.rows, 'skipped'))} | ${String(count(lane.rows, 'n/a'))} |`,
    ),
    '',
    ...(needsKey
      ? [
          '`skipped` means `ANTHROPIC_API_KEY` is not configured for this repository. It is not a pass.',
          '',
        ]
      : []),
    ...(missing.length > 0
      ? [`No results from: ${missing.map((lane) => lane.name).join(', ')}.`, '']
      : []),
    ...failures.slice(0, MAX_FAILURES),
    ...(failures.length > MAX_FAILURES
      ? [`- ... and ${String(failures.length - MAX_FAILURES)} more`]
      : []),
    ...knownFailures,
    ...stale.map(
      (entry) =>
        `- stale known failure: ${entry.lane}: ${entry.where} (#${String(entry.issue)}) passes; remove it from tests/docs-claims/install-live-known.json`,
    ),
  ].join('\n');
  return { outcome, markdown, digest };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, ...names] = process.argv.slice(2);
  if (directory === undefined || names.length === 0) {
    console.error(
      'usage: node tests/docs-claims/install-live-report.mjs <results directory> <lane>...',
    );
    process.exitCode = 2;
  } else {
    const lanes = names.map((name) => {
      const file = path.join(directory, `install-live-${name}`, 'results.json');
      return { name, rows: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
    });
    const known = parseKnown(JSON.parse(readFileSync(KNOWN_FILE, 'utf8')));
    const { outcome, markdown, digest } = verdict(lanes, known);
    console.log(markdown);
    const output = process.env['GITHUB_OUTPUT'];
    if (output !== undefined && output !== '') {
      appendFileSync(output, `outcome=${outcome}\ndigest=${digest}\n`);
    }
  }
}
