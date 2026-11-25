#!/usr/bin/env node
// The approval route the authority schedule requires, as `run_skill_script` runs it:
//
//   route.mjs <authority-matrix.csv> <category> <amount-yen>
//
// It reads the schedule (Japanese or English columns) with the built-in table reader (ADR-0173)
// and prints the first row of the category whose limit the amount (yen, excluding tax) does not
// exceed: `{ category, amountYen, approver, coReview, clause, standard }`, `standard` being the rule's
// code and section (`GR-003 §3.1`). A row with an empty limit covers every larger amount. The amount
// may be written as a ringi writes it (`45,000,000円`, `¥45,000,000`, `45000000 yen`, full-width
// digits). An unknown category or an amount that is not whole yen is refused on stderr.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

const COLUMNS = /** @type {const} */ ({
  category: ['区分', 'category'],
  limit: { names: ['上限（税抜・円）', 'limit (yen ex tax)'], type: 'whole', optional: true },
  approver: ['決裁者', 'approver'],
  coReview: { names: ['合議', 'co-review'], optional: true },
  clause: ['出典', 'clause'],
  standard: ['規程番号', 'standard'],
});

export const SPEC = {
  usage: 'route.mjs <authority-matrix.csv> <category> <amount-yen>',
  positionals: ['matrix', 'category', 'amount'],
};

/**
 * The route for `category` and `amount` (whole yen, as text) in the schedule's `rows`.
 * @param {readonly { category: string, limit: number | null, approver: string, coReview: string | null, clause: string, standard: string }[]} rows
 * @param {string} category
 * @param {string} amount
 * @throws {TableError}
 */
function route(rows, category, amount) {
  // NFKC folds full-width digits, commas and the yen sign; the separators and units then go.
  const digits = amount.normalize('NFKC').replace(/[\s,円¥]|yen/giu, '');
  if (!/^\d+$/u.test(digits)) throw new TableError('usage', `"${amount}" is not whole yen`);
  const amountYen = Number(digits);
  const row = rows.find(
    (candidate) =>
      candidate.category === category && (candidate.limit === null || amountYen <= candidate.limit),
  );
  if (row === undefined)
    throw new TableError('no_route', `the schedule has no row for ${category}`);
  const { approver, coReview, clause, standard } = row;
  return { category, amountYen, approver, coReview, clause, standard };
}

/** @param {{ positionals: Readonly<Record<string, string>> }} args */
export const compute = ({ positionals }) =>
  route(
    readTable(String(positionals['matrix']), { columns: COLUMNS }).rows,
    String(positionals['category']),
    String(positionals['amount']),
  );

runWhenMain(import.meta.url, SPEC, compute);
