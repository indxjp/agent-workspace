#!/usr/bin/env node
// Past incidents like a new defect, and their causes ranked, as `run_skill_script` runs it:
//
//   analyse.mjs <defect-reports.csv|.xlsx> --symptom <symptom> [--process <process>] [--fmea <fmea.xlsx>]
//
// It reads a QMS export of past defect reports (one row per report; the Japanese or the English
// column names) with the built-in table reader (ADR-0173) and keeps the reports of the same symptom
// (and process, when given), compared without case or surrounding spaces. It prints JSON: those
// reports, newest first, each with its cause and fix; the causes ranked by how many of them name
// it (then by the newest), each with its 4M, the pieces affected and whether it recurred; the
// count per 4M; and, with `--fmea`, the FMEA rows of that process and failure mode. A file, row,
// column or value it cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the
// arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import * as table from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

const REPORTS = /** @type {const} */ ({
  no: ['不具合番号', 'defect no'],
  date: { names: ['発生日', 'date'], type: 'date' },
  part: ['品番', 'part no'],
  process: ['工程', 'process'],
  symptom: ['現象', 'symptom'],
  count: { names: ['発生数', 'count'], type: 'whole' },
  cause: ['原因区分', 'cause class'],
  fourM: ['4M'],
  detail: ['原因', 'cause'],
  fix: ['対策', 'fix'],
  recurred: ['再発', 'recurred'],
});
const FMEA = /** @type {const} */ ({
  no: ['No.'],
  process: ['工程', 'process'],
  mode: ['故障モード', 'failure mode'],
  cause: ['故障原因', 'cause'],
  control: ['現行の管理', 'current control'],
  rpn: { names: ['RPN'], type: 'whole' },
});

export const SPEC = {
  usage:
    'analyse.mjs <defect-reports.csv> --symptom <symptom> [--process <process>] [--fmea <fmea.xlsx>]',
  positionals: ['file'],
  options: { symptom: {}, process: { default: '' }, fmea: { default: '' } },
};

const same = (/** @type {string} */ a, /** @type {string} */ b) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** @param {import('@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs').ParsedArgs} args */
export function compute({ positionals, options }) {
  const [symptom, where] = [options['symptom'] ?? '', String(options['process'])];
  if (symptom.trim() === '') throw new table.TableError('usage', '--symptom names the symptom');
  const { rows } = table.readTable(String(positionals['file']), { columns: REPORTS });
  const fits = (/** @type {{ process: string }} */ row) => where === '' || same(row.process, where);
  const matched = rows
    .filter((row) => same(row.symptom, symptom) && fits(row))
    .sort((a, b) => b.date.localeCompare(a.date));
  const incidents = matched.map(
    ({ no, date, part, process, cause, fourM, detail, fix, recurred }) => ({
      ...{ no, date, part, process, cause, fourM, detail, fix },
      recurred: ['有', 'yes'].includes(recurred),
    }),
  );
  const causes = [...new Set(incidents.map((incident) => incident.cause))].map((cause) => {
    const own = incidents.filter((incident) => incident.cause === cause);
    const pieces = matched
      .filter((row) => row.cause === cause)
      .reduce((sum, row) => sum + row.count, 0);
    const recurred = own.some((incident) => incident.recurred);
    return {
      cause,
      fourM: String(own.map((incident) => incident.fourM)[0]),
      incidents: own.length,
      pieces,
      recurred,
      reports: own.map((i) => i.no),
    };
  });
  causes.sort((a, b) => b.incidents - a.incidents);
  const fourM = [...new Set(incidents.map((incident) => incident.fourM))].map((label) => ({
    label,
    value: incidents.filter((incident) => incident.fourM === label).length,
  }));
  const sheet = options['fmea']
    ? table.readTable(String(options['fmea']), { columns: FMEA }).rows
    : [];
  const fmea = sheet.filter((row) => same(row.mode, symptom) && fits(row));
  return { symptom, process: where, matched: incidents.length, causes, fourM, incidents, fmea };
}

runWhenMain(import.meta.url, SPEC, compute);
