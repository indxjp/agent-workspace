#!/usr/bin/env node
// Customer segments, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <orders.csv|orders.xlsx> [--as-of YYYY-MM-DD]
//
// It reads an order export (one row per order: the order date, the customer, the product category
// and the amount in whole yen) with the built-in table reader (ADR-0173) and prints JSON on stdout.
// As of a day (default: the export's last order date; later orders are left out), each customer's
// days since the last order and number of orders put them in one segment, by fixed rules:
// ordered within RECENT days and 4 or more orders, `loyal`; 2 or 3, `regular`; 1, `new`; last
// order RECENT + 1 to LAPSED days ago, `atRisk`; longer, `lapsed`. Per segment: customers, orders,
// revenue, its share of all revenue (a percent to one decimal), the average orders per customer
// (two decimals), the average days since the last order (a whole number) and the category with the
// most revenue. Segment names follow the export's language (its header). It never prints a
// customer ID. A file, row, value or option it cannot read prints `{ "error", "message" }` on
// stderr and exits 1 (2 for the arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

const [RECENT, LAPSED, DAY] = [90, 180, 86_400_000];
/** The segments in order, with their Japanese and English names. */
const SEGMENTS = /** @type {const} */ ({
  loyal: ['優良', 'Loyal'],
  regular: ['一般', 'Regular'],
  new: ['新規', 'New'],
  atRisk: ['離反懸念', 'At risk'],
  lapsed: ['休眠', 'Lapsed'],
});
const COLUMNS = /** @type {const} */ ({
  date: { names: ['注文日', 'order_date'], type: 'date' },
  customer: ['顧客ID', 'customer_id'],
  category: ['商品カテゴリ', 'category'],
  amount: { names: ['金額', 'amount'], type: 'whole' },
});

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <orders.csv|orders.xlsx> [--as-of YYYY-MM-DD]',
  positionals: ['file'],
  options: { 'as-of': {} },
};

/** The segment of a customer `days` after the last of `orders` orders. */
function segmentOf(/** @type {number} */ days, /** @type {number} */ orders) {
  if (days > LAPSED) return 'lapsed';
  if (days > RECENT) return 'atRisk';
  return orders >= 4 ? 'loyal' : orders >= 2 ? 'regular' : 'new';
}

/**
 * The segments of the export's orders; `columns` is its header as written (it sets the language).
 * @param {{ columns: readonly string[], rows: readonly { date: string, customer: string, category: string, amount: number }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ 'as-of'?: string }>} options `as-of` (YYYY-MM-DD)
 * @throws {TableError}
 */
export function analyse({ columns, rows, rowNumbers }, options) {
  const negative = rows.findIndex((row) => row.amount < 0);
  if (negative !== -1)
    throw new TableError('out_of_range', `row ${String(rowNumbers[negative])}: a negative amount`, {
      row: Number(rowNumbers[negative]),
      column: 'amount',
    });
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const asOf =
    options['as-of'] ??
    String(
      rows
        .map((row) => row.date)
        .sort()
        .at(-1),
    );
  const time = /^\d{4}-\d{2}-\d{2}$/u.test(asOf) ? Date.parse(asOf) : Number.NaN;
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== asOf)
    throw new TableError('usage', `--as-of "${asOf}" is not a YYYY-MM-DD date`);
  const upTo = rows.filter((row) => row.date <= asOf);
  if (upTo.length === 0) throw new TableError('no_orders', `no order on or before ${asOf}`);
  const lang = columns.includes('顧客ID') ? 0 : 1;
  const customers = [...new Set(upTo.map((row) => row.customer))].map((customer) => {
    const own = upTo.filter((row) => row.customer === customer);
    const last = own
      .map((row) => row.date)
      .sort()
      .at(-1);
    const days = (Date.parse(asOf) - Date.parse(String(last))) / DAY;
    return { segment: segmentOf(days, own.length), days, own };
  });
  const revenueOf = (/** @type {readonly { amount: number }[]} */ list) =>
    list.reduce((sum, row) => sum + row.amount, 0);
  const revenue = revenueOf(upTo);
  const segments = Object.entries(SEGMENTS).flatMap(([key, names]) => {
    const members = customers.filter((customer) => customer.segment === key);
    const own = members.flatMap((member) => member.own);
    if (members.length === 0) return [];
    const categories = [...new Set(own.map((row) => row.category))].map((category) => ({
      category,
      revenue: revenueOf(own.filter((row) => row.category === category)),
    }));
    const top = categories.reduce((best, next) => (next.revenue > best.revenue ? next : best));
    return [
      {
        segment: names[lang],
        customers: members.length,
        orders: own.length,
        revenue: revenueOf(own),
        share: revenue === 0 ? 0 : Math.round((revenueOf(own) * 1000) / revenue) / 10,
        avgOrders: Math.round((own.length * 100) / members.length) / 100,
        avgDays: Math.round(members.reduce((sum, member) => sum + member.days, 0) / members.length),
        topCategory: top.category,
      },
    ];
  });
  const from = upTo.map((row) => row.date).sort()[0];
  const total = { customers: customers.length, orders: upTo.length, revenue };
  return { asOf, from, recentDays: RECENT, lapsedDays: LAPSED, total, segments };
}

/**
 * The command line: read the export named first, then segment it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
