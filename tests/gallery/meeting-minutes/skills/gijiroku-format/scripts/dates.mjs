#!/usr/bin/env node
/* global process */ // The root ESLint config declares no environment globals.
// Resolve the relative Japanese dates people say in meetings (今日, 明日, 来週金曜, 月末, 来月10日,
// 3営業日後 …) against the meeting's date, so the minutes carry YYYY-MM-DD the tracker accepts.
//
// A model is unreliable at calendar arithmetic ("来週金曜" from a Friday, the last day of a month,
// business days across a weekend), so the gijiroku-format skill runs this script instead:
//
//   node dates.mjs <基準日 YYYY-MM-DD> <表現> [<表現> …]
//   → [{ "expression": "来週金曜", "date": "2026-10-09" }, { "expression": "なるべく早く", "date": null }]
//
// Conventions (written in SKILL.md too):
// - A week starts on Monday. 今週X曜 is X in the meeting's week, 来週X曜 in the week after,
//   再来週X曜 two weeks after. 週明け is next Monday.
// - 月末 is the calendar last day of the month, even on a weekend.
// - N営業日後 skips Saturdays, Sundays and the optional holiday list; N日後 counts calendar days.
// - M月D日 without a year is the next such date on or after the meeting date.
// - Anything else (なるべく早く, 近いうちに, 次回まで) resolves to null: the minutes say 期限未定.
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;
const WEEKDAYS = '日月火水木金土';

/** Parse a strict YYYY-MM-DD into a UTC date, or null when it is not a real calendar date. */
export function parseIsoDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (match === null) return null;
  return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date : null;
}

export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
const isWeekend = (date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;
const lastDayOf = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0));

/** The date `count` business days after `base`, skipping weekends and `holidays` (YYYY-MM-DD). */
export function addBusinessDays(base, count, holidays = []) {
  const closed = new Set(holidays);
  let date = base;
  let left = count;
  while (left > 0) {
    date = addDays(date, 1);
    if (!isWeekend(date) && !closed.has(formatDate(date))) left -= 1;
  }
  return date;
}

/** Full-width digits to ASCII, spaces and the trailing 「まで(に)」「中」「頃」 removed. */
function normalise(expression) {
  return expression
    .replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]/gu, '')
    .replace(/(までに|まで|中|頃|ごろ|くらい|ぐらい)+$/u, '')
    .replace(/の/gu, '');
}

const MONTH_OFFSET = { 今月: 0, 来月: 1, 再来月: 2 };
const WEEK_OFFSET = { 今週: 0, 来週: 1, 再来週: 2 };

/**
 * Resolve one expression against `base` (YYYY-MM-DD). Returns YYYY-MM-DD, or null when the
 * expression names no date. Throws when `base` itself is not a date.
 */
export function resolveDate(expression, base, options = {}) {
  const start = parseIsoDate(base);
  if (start === null) throw new Error(`base must be YYYY-MM-DD: ${base}`);
  const holidays = options.holidays ?? [];
  const text = normalise(expression);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  let match;

  if (/^(今日|本日)$/u.test(text)) return formatDate(start);
  if (/^(明日|あした|あす)$/u.test(text)) return formatDate(addDays(start, 1));
  if (/^(明後日|あさって)$/u.test(text)) return formatDate(addDays(start, 2));

  if ((match = /^(\d+)営業日後$/u.exec(text)) !== null)
    return formatDate(addBusinessDays(start, Number(match[1]), holidays));
  if ((match = /^(\d+)日後$/u.exec(text)) !== null)
    return formatDate(addDays(start, Number(match[1])));

  const monday = addDays(start, -((start.getUTCDay() + 6) % 7));
  if (text === '週明け') return formatDate(addDays(monday, 7));
  if ((match = /^(今週|来週|再来週)([月火水木金土日])(曜日?)?$/u.exec(text)) !== null) {
    const offset = (WEEKDAYS.indexOf(match[2]) + 6) % 7; // Monday = 0 … Sunday = 6
    return formatDate(addDays(monday, WEEK_OFFSET[match[1]] * 7 + offset));
  }

  if ((match = /^(今月|来月|再来月)?末$/u.exec(text)) !== null || text === '月末')
    return formatDate(lastDayOf(year, month + (MONTH_OFFSET[match?.[1]] ?? 0)));
  if ((match = /^(今月|来月|再来月)(\d{1,2})日$/u.exec(text)) !== null) {
    const target = new Date(Date.UTC(year, month + MONTH_OFFSET[match[1]], 1));
    const date = calendarDate(target.getUTCFullYear(), target.getUTCMonth() + 1, Number(match[2]));
    return date === null ? null : formatDate(date);
  }

  if ((match = /^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?$/u.exec(text)) !== null) {
    const date = calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return date === null ? null : formatDate(date);
  }
  if ((match = /^(\d{1,2})(?:月|\/)(\d{1,2})日?$/u.exec(text)) !== null) {
    const [m, d] = [Number(match[1]), Number(match[2])];
    const thisYear = calendarDate(year, m, d);
    if (thisYear !== null && thisYear >= start) return formatDate(thisYear);
    const nextYear = calendarDate(year + 1, m, d);
    return nextYear === null ? null : formatDate(nextYear);
  }
  return null;
}

/** The weekday of a YYYY-MM-DD in Japanese, for the minutes' 日時 line: 「金」. */
export function weekdayOf(isoDate) {
  const date = parseIsoDate(isoDate);
  if (date === null) throw new Error(`not a date: ${isoDate}`);
  return WEEKDAYS[date.getUTCDay()];
}

function main(argv) {
  const [base, ...expressions] = argv;
  if (base === undefined || expressions.length === 0) {
    process.stderr.write('usage: node dates.mjs <基準日 YYYY-MM-DD> <表現> [<表現> …]\n');
    return 2;
  }
  if (parseIsoDate(base) === null) {
    process.stderr.write(`基準日は YYYY-MM-DD で指定してください: ${base}\n`);
    return 2;
  }
  const resolved = expressions.map((expression) => ({
    expression,
    date: resolveDate(expression, base),
  }));
  process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
