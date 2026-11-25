#!/usr/bin/env node
// The minutes, saved with every relative deadline turned into a date, as `run_skill_script` runs it:
//
//   minutes.mjs <out.md> --date <meeting date YYYY-MM-DD> --text <minutes> [--undated <label>]
//
// The minutes are Markdown in which each deadline is written as it was said, `{{due:<phrase>}}`. The
// phrase is resolved from the meeting date: a date as written (2026-10-09); 明日 / tomorrow; 週明け /
// early next week (the next Monday); 今週・来週・再来週 <曜日> / this, next <weekday> (weeks start on
// Monday); 月末 / end of the month (the calendar's last day); 来月<N>日 / the <N>th of next month;
// <N>日後 / in <N> days; <N>営業日後 / in <N> business days (Saturdays and Sundays skipped, holidays
// not). Any other phrase ("as soon as possible") is no date: it becomes `<label> (<phrase>)`. It
// writes the file, never over an existing one, and prints each deadline with its date.
import { existsSync, writeFileSync } from 'node:fs';

import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { TableError } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

export const SPEC = {
  usage: 'minutes.mjs <out.md> --date <YYYY-MM-DD> --text <minutes> [--undated <label>]',
  positionals: ['out'],
  options: { date: {}, text: {}, undated: { default: '期限未定' } },
};
// 今週・来週・再来週 / this, next + a weekday, the whole phrase: 'next month' is no weekday.
const WEEK =
  /^(今週|来週|再来週|this |next )([月火水木金土日]|mon|tue|wed|thu|fri|sat|sun)(曜日?|[a-z]*day)?$/u;
const DAYS = [...'月火水木金土日', ...'mon tue wed thu fri sat sun'.split(' ')];

/**
 * The date `phrase` names, said at a meeting on `date` (YYYY-MM-DD), or null.
 * @param {string} date @param {string} phrase
 */
export function resolve(date, phrase) {
  const start = new Date(`${date}T00:00:00Z`);
  const [year, month] = [start.getUTCFullYear(), start.getUTCMonth()];
  const monday = (start.getUTCDay() + 6) % 7;
  /** @param {number} m months on @param {number} d the day of that month */
  const on = (m, d) => new Date(Date.UTC(year, month + m, d)).toISOString().slice(0, 10);
  const day = (/** @type {number} */ n) => on(0, start.getUTCDate() + n);
  const said = phrase.trim().toLowerCase();
  const week = WEEK.exec(said);
  const index = DAYS.indexOf(String(week?.[2])) % 7;
  const shift = { 来週: 7, 'next ': 7, 再来週: 14 }[String(week?.[1])] ?? 0;
  const count = Number(/^(\d+)/u.exec(said.replace(/^in /u, ''))?.[1]);
  const next = /^(?:来月(\d+)日|the (\d+)(?:st|nd|rd|th) of next month)$/u.exec(said);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(said)) return said;
  if (said === '明日' || said === 'tomorrow') return day(1);
  if (said === '週明け' || said === 'early next week') return day(7 - monday);
  if (index >= 0) return day(shift - monday + index);
  if (said === '月末' || said === 'end of the month') return on(1, 0);
  if (next) return on(1, Number(next[1] ?? next[2]));
  if (/^(\d+日後|in \d+ days?)$/u.test(said)) return day(count);
  if (!/^(\d+営業日後|in \d+ business days?)$/u.test(said)) return null;
  let n = 0;
  for (let left = count; left > 0;) left -= (monday + ++n) % 7 < 5 ? 1 : 0;
  return day(n);
}

/** @param {import('@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs').ParsedArgs} args */
export function compute({ positionals, options }) {
  const [out, date] = [String(positionals['out']), String(options['date'])];
  const real = new Date(Date.parse(date) || 0).toISOString().slice(0, 10) === date;
  if (!real || !options['text']) throw new TableError('usage', '--date YYYY-MM-DD, --text');
  if (existsSync(out)) throw new TableError('output_exists', `${out} exists already`);
  /** @type {{ said: string, due: string | null }[]} */
  const deadlines = [];
  const text = String(options['text']).replace(/\{\{due:([^}]+)\}\}/gu, (_, said) => {
    const due = resolve(date, String(said));
    deadlines.push({ said: String(said), due });
    return due ?? `${String(options['undated'])} (${String(said)})`;
  });
  writeFileSync(out, `${text.trim()}\n`);
  return { written: out, date, deadlines };
}

runWhenMain(import.meta.url, SPEC, compute);
