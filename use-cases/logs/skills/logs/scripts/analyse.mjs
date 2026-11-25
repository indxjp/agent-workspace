#!/usr/bin/env node
// Error timing and patterns in an application log export, by rule, as `run_skill_script` runs it
// (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <export.csv|export.xlsx> [--bucket <minutes>] [--service <name>]
//
// It reads a log export (one row per line: timestamp, level, service, message; the Japanese or
// the English column names) with the built-in table reader (ADR-0173). It counts the errors and
// warnings in each bucket of time (default 10 minutes, a divisor of 60) from the first line to
// the last, by the clock the timestamps are written in (all with one offset), finds the bucket
// with the most errors, and groups the errors and warnings into patterns: the same level, service
// and message once secrets and personal data are masked (an e-mail address, an IPv4 address, a
// value after a key naming a password, token, secret, API key, authorization, cookie or session,
// a bearer token, the user and password in a URL, an IPv6 address) and numbers are `#`; it
// prints the 20 most frequent and counts the rest. Nothing it prints holds a masked value; it prints how many it masked. A file, row, column,
// value or option it cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the
// arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  dateValue,
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The export's columns: the Japanese and the English name. */
const COLUMNS = /** @type {const} */ ({
  time: ['日時', 'timestamp'],
  level: ['レベル', 'level'],
  service: ['サービス', 'service'],
  message: ['メッセージ', 'message'],
});

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <export.csv|export.xlsx> [--bucket <minutes>] [--service <name>]',
  positionals: ['file'],
  options: { bucket: { default: '10' }, service: {} },
};

/** A key that names a secret (`password`, `db_password`, `"token"`, `Authorization: Basic …`), and its value. */
const KEY = String.raw`([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|authorization|session|パスワード)[\w-]*)(["']?\s*[=:：]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s,;&"']+`;
/** An IPv6 address: one with `::`, or eight groups (a time such as `14:03:12` is neither). */
const IPV6 = String.raw`(?<![\w:])(?=[0-9a-f:]*::|(?:[0-9a-f]{1,4}:){7}[0-9a-f])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])`;
/** What is masked, in order, and what it becomes. */
const MASKS = /** @type {const} */ ([
  [/\b([a-z][\w+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/giu, '$1<redacted>@'],
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]*/giu, '$1<redacted>'],
  [new RegExp(KEY, 'giu'), '$1$2<redacted>'],
  [/\bbearer\s+[\w.~+/-]+=*/giu, 'Bearer <redacted>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, '<email>'],
  [new RegExp(IPV6, 'giu'), '<ip>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, '<ip>'],
]);
/** How many patterns it prints; the rest are counted in `otherPatterns`. */
const TOP = 20;

/** `message` with every secret and personal value masked, and how many were. */
export function mask(/** @type {string} */ message) {
  let [text, masked] = [message, 0];
  for (const [pattern, replacement] of MASKS) {
    text = text.replace(pattern, (...match) => {
      masked += 1;
      return replacement.replace(/\$(\d)/gu, (_, at) => String(match[Number(at)]));
    });
  }
  return { text, masked };
}

const STAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/u;

/** The minute a timestamp is in, counted from 1970 by its own clock, and its offset. */
function minuteOf(/** @type {string} */ time, /** @type {number} */ row) {
  const parts = STAMP.exec(time);
  const [hour, minute, second] = [Number(parts?.[2]), Number(parts?.[3]), Number(parts?.[4])];
  if (parts === null || hour > 23 || minute > 59 || second > 59)
    throw new TableError('not_a_timestamp', `"${time}" is not a timestamp`, { row });
  const day = dateValue(String(parts[1]), { row, column: 'timestamp' });
  return {
    at: Date.parse(`${day}T00:00:00Z`) / 60_000 + hour * 60 + minute,
    offset: parts[5] ?? '',
  };
}

/** The minute `at` as `YYYY-MM-DD HH:MM`. */
const clock = (/** @type {number} */ at) =>
  new Date(at * 60_000).toISOString().slice(0, 16).replace('T', ' ');

/**
 * The analysis of the export's rows; `rowNumbers[i]` is where `rows[i]` is in the file.
 * @param {{ rows: readonly { time: string, level: string, service: string, message: string }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ bucket?: string, service?: string }>} options
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const size = Number(options.bucket ?? '10');
  if (!Number.isInteger(size) || size < 1 || 60 % size !== 0)
    throw new TableError('usage', `--bucket "${String(options.bucket)}" does not divide an hour`);
  const lines = rows
    .map((row, at) => ({
      ...row,
      level: row.level.toUpperCase(),
      ...minuteOf(row.time, Number(rowNumbers[at])),
    }))
    .filter((line) => options.service === undefined || line.service === options.service);
  if (lines.length === 0) throw new TableError('no_rows', 'no log line to analyse');
  if (new Set(lines.map((line) => line.offset)).size > 1)
    throw new TableError('mixed_offsets', 'the timestamps are written with more than one offset');
  lines.sort((a, b) => a.at - b.at);
  const [head, tail] = /** @type {[(typeof lines)[number], (typeof lines)[number]]} */ ([
    lines[0],
    lines.at(-1),
  ]);
  const start = head.at - (head.at % size);
  const buckets = Array.from({ length: Math.floor((tail.at - start) / size) + 1 }, (_, at) => ({
    start: clock(start + at * size),
    errors: 0,
    warnings: 0,
  }));
  /** @type {Map<string, { level: string, service: string, pattern: string, count: number, first: string, last: string }>} */
  const patterns = new Map();
  let redactions = 0;
  for (const line of lines) {
    if (line.level !== 'ERROR' && line.level !== 'WARN') continue;
    const bucket = /** @type {(typeof buckets)[number]} */ (
      buckets[Math.floor((line.at - start) / size)]
    );
    bucket[line.level === 'ERROR' ? 'errors' : 'warnings'] += 1;
    const { text, masked } = mask(line.message);
    redactions += masked;
    const pattern = text.replace(/\d+/gu, '#');
    const key = `${line.level} ${line.service} ${pattern}`;
    const [at, { level, service }] = [clock(line.at), line];
    const seen = patterns.get(key) ?? { level, service, pattern, count: 0, first: at, last: at };
    patterns.set(key, { ...seen, count: seen.count + 1, last: at });
  }
  const peak = buckets.reduce((most, one) => (one.errors > most.errors ? one : most));
  return {
    from: head.time,
    to: tail.time,
    linesRead: lines.length,
    bucketMinutes: size,
    peak: peak.errors === 0 ? null : { start: peak.start, errors: peak.errors },
    buckets,
    // Patterns are kept in the order first seen; a stable sort keeps that order within a count.
    patterns: [...patterns.values()].sort((a, b) => b.count - a.count).slice(0, TOP),
    otherPatterns: Math.max(0, patterns.size - TOP),
    redactions,
  };
}

/**
 * The command line: read the export named first, then analyse it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
