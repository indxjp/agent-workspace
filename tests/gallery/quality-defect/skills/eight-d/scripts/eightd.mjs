#!/usr/bin/env node
/* global process */ // The root ESLint config declares no environment globals.
// Parse and check an 8D report draft written in the eight-d skill's Markdown format, with Node
// alone. The agent runs it on its own draft before answering. The backend imports `checkEightD`
// (typed by eightd.d.mts) and runs it on the structure the run returns, so the checks have one
// definition; `parseEightD` is the same checks after reading the Markdown.
//
//   node eightd.mjs <draft.md>        → JSON on stdout; exit 1 when not valid
//   node eightd.mjs --text <draft>    the draft itself as the argument (run_skill_script has no stdin)
//   node eightd.mjs -                 the draft on stdin
//
// The checks are the ones a design review (DR) would otherwise do by eye:
//   - all eight disciplines D1–D8 are present, once each, in order;
//   - the なぜなぜ chain in D4 is at least three whys deep and numbered 1, 2, 3 …;
//   - every root-cause claim in D4 (each なぜ, each bullet, the 根本原因 line) cites a past case
//     as 〔過去トラ Q-1234〕.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DISCIPLINES = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
export const FOUR_M = ['人', '機械', '材料', '方法'];
export const MIN_WHYS = 3;

const HEADING = /^#{2,3}\s*[DＤ]([1-8１-８])(?![0-9０-９])[\s.:：]*(.*)$/u;
const TITLE = /^#\s+(.+)$/u;
const WHY = /^(?:[-*]\s*)?なぜ\s*([0-9０-９]+)\s*[:：]\s*(.+)$/u;
const BULLET = /^(?:[-*]|[0-9]+\.)\s+(.+)$/u;
const ROOT_CAUSE = /^(?:[-*]\s*)?根本原因\s*[:：]\s*(.+)$/u;
const CAUSE_CODE = /^原因区分\s*[:：]\s*(.+)$/u;
const FOUR_M_LINE = /^4M集計\s*[:：]\s*(.+)$/u;
const FOUR_M_COUNT = /(人|機械|材料|方法)\s*([0-9０-９]+)\s*件?/gu;
const SIMILAR = /類似\s*([0-9０-９]+)\s*件/u;
const CASE_CITATION = /〔過去トラ\s*([^〔〕]+)〕/gu;
const CASE_ID = /Q-[0-9]{4}/gu;

/** The Q-numbers cited as 〔過去トラ Q-1234〕 or 〔過去トラ Q-1234、Q-1235〕 in `text`, in order. */
export function citedCases(text) {
  const ids = [];
  for (const match of text.matchAll(CASE_CITATION)) {
    for (const id of (match[1] ?? '').normalize('NFKC').matchAll(CASE_ID)) ids.push(id[0]);
  }
  return ids;
}

/** A number written with ASCII or full-width digits. */
function toNumber(digits) {
  return Number((digits ?? '').normalize('NFKC'));
}

function unique(values) {
  return [...new Set(values)];
}

/** Parse the 4M line's counts; null when the draft has no 4M集計 line. */
function fourMOf(lines) {
  for (const line of lines) {
    const match = FOUR_M_LINE.exec(line);
    if (match === null) continue;
    const counts = {};
    for (const count of (match[1] ?? '').matchAll(FOUR_M_COUNT)) {
      counts[count[1]] = toNumber(count[2]);
    }
    const similar = SIMILAR.exec(match[1] ?? '');
    return { counts, total: similar === null ? null : toNumber(similar[1]), line: line.trim() };
  }
  return null;
}

/**
 * Check a draft's structure: its title, the D1–D8 sections, the D4 なぜなぜ chain, the D4 claims
 * (each なぜ, bullet and the 根本原因 line), the root cause, the 原因区分 and the quoted 4M counts.
 * Pure: the same structure gives the same result. The structure comes from `parseEightD` or, in the
 * backend, from a run's structured output.
 */
export function checkEightD(draft) {
  const { sections, whys, claims, rootCause } = draft;
  const issues = [];
  const seen = sections.map((section) => section.id);
  for (const id of DISCIPLINES) {
    const count = seen.filter((value) => value === id).length;
    if (count === 0) issues.push({ code: 'missing_section', section: id, message: `${id} がない` });
    if (count > 1) issues.push({ code: 'duplicate_section', section: id, message: `${id} が重複` });
  }
  const order = seen.filter((id, index) => seen.indexOf(id) === index);
  if (order.join() !== DISCIPLINES.filter((id) => order.includes(id)).join()) {
    issues.push({ code: 'section_order', section: null, message: 'D1〜D8 の順序が違う' });
  }

  const d4 = sections.find((section) => section.id === 'D4');
  if (d4 !== undefined && whys.length < MIN_WHYS) {
    issues.push({
      code: 'shallow_whys',
      section: 'D4',
      message: `なぜなぜが ${String(whys.length)} 段（${String(MIN_WHYS)} 段以上必要）`,
    });
  }
  if (whys.some((why, index) => why.depth !== index + 1)) {
    issues.push({
      code: 'whys_out_of_order',
      section: 'D4',
      message: 'なぜの番号が 1 から連番でない',
    });
  }
  if (d4 !== undefined && rootCause === null) {
    issues.push({ code: 'missing_root_cause', section: 'D4', message: '根本原因の行がない' });
  }
  // A structure from a run need not repeat each なぜ and the 根本原因 in `claims`, so they are checked
  // too, unless an uncited claim containing the same text is already reported (as parseEightD's are).
  const uncited = claims.filter((claim) => claim.cites.length === 0);
  const reported = (text) => uncited.some((claim) => claim.text.includes(text));
  const unclaimed = [...whys, ...(rootCause === null ? [] : [rootCause])].filter(
    (claim) => claim.cites.length === 0 && !reported(claim.text),
  );
  for (const claim of [...uncited, ...unclaimed]) {
    issues.push({
      code: 'uncited_claim',
      section: 'D4',
      message: `出典〔過去トラ Q-xxxx〕がない: ${claim.text}`,
    });
  }

  return {
    ...draft,
    // Every place a case can be cited, the section prose included, so no field hides a Q-number.
    cites: unique([
      ...sections.flatMap((section) => [...section.cites, ...citedCases(section.body)]),
      ...whys.flatMap((why) => why.cites),
      ...claims.flatMap((claim) => claim.cites),
      ...(rootCause?.cites ?? []),
    ]),
    issues,
    valid: issues.length === 0,
  };
}

/**
 * Parse `markdown` into its title, the D1–D8 sections, the D4 なぜなぜ chain and root-cause claims,
 * the 原因区分 and the quoted 4M counts, and check it with `checkEightD`.
 * Pure: the same text gives the same result.
 */
export function parseEightD(markdown) {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  let title = null;
  const sections = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading !== null) {
      current = {
        id: `D${String(toNumber(heading[1]))}`,
        title: (heading[2] ?? '').trim(),
        lines: [],
      };
      sections.push(current);
      continue;
    }
    const top = TITLE.exec(line);
    if (top !== null && title === null && sections.length === 0) {
      title = (top[1] ?? '').trim();
      continue;
    }
    if (current !== null && line !== '') current.lines.push(line);
  }

  const d4Lines = sections.find((section) => section.id === 'D4')?.lines ?? [];
  const whys = [];
  const claims = [];
  let rootCause = null;
  let causeCode = null;
  for (const line of d4Lines) {
    const why = WHY.exec(line);
    const root = ROOT_CAUSE.exec(line);
    const code = CAUSE_CODE.exec(line);
    if (code !== null) {
      causeCode = (code[1] ?? '').replace(CASE_CITATION, '').trim();
      continue;
    }
    if (FOUR_M_LINE.test(line)) continue;
    if (why !== null) {
      const entry = {
        depth: toNumber(why[1]),
        text: (why[2] ?? '').trim(),
        cites: citedCases(line),
      };
      whys.push(entry);
      claims.push({ text: line, cites: entry.cites });
    } else if (root !== null) {
      rootCause = { text: (root[1] ?? '').trim(), cites: citedCases(line) };
      claims.push({ text: line, cites: rootCause.cites });
    } else if (BULLET.test(line)) {
      claims.push({ text: line, cites: citedCases(line) });
    }
  }

  return checkEightD({
    title,
    sections: sections.map(({ lines: body, ...section }) => ({
      ...section,
      body: body.join('\n'),
      cites: unique(body.flatMap(citedCases)),
    })),
    whys,
    claims,
    rootCause,
    causeCode,
    fourM: fourMOf(d4Lines),
  });
}

// ---------- command line ----------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, text] = process.argv.slice(2);
  if (file === undefined || (file === '--text' && text === undefined)) {
    process.stderr.write('usage: node eightd.mjs <draft.md | - | --text <draft>>\n');
    process.exit(2);
  }
  const result = parseEightD(
    file === '--text' ? (text ?? '') : readFileSync(file === '-' ? 0 : file, 'utf8'),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.valid ? 0 : 1;
}
