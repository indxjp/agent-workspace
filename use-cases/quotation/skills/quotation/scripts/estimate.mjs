#!/usr/bin/env node
// The cost of one sheet-metal part, as `run_skill_script` runs it (`node estimate.mjs <args>`):
//
//   estimate.mjs <rates.csv> <material> --length <mm> --width <mm> --thickness <mm>
//                --holes <n> --diameter <mm> --bends <n> --quantity <n>
//
// It reads the ERP's rate table (one row per material and thickness band, Japanese or English
// columns) with the built-in table reader (ADR-0173), takes the row of the material with the
// smallest thickness limit the part fits under, and prints the breakdown per piece as JSON:
//   material = L × W × T (mm³) ÷ 1000 → cm³ × density ÷ 1000 → kg × yen/kg ÷ yield, to the yen (half up)
//   cutting  = (2 × (L + W) + holes × π × diameter) mm ÷ 1000 → m × yen/m, to the yen (half up)
//   bending  = bends × yen/bend;   setup = yen/lot ÷ quantity, rounded up to the yen
//   cost     = the four lines;     unit price = cost × (1 + margin), rounded up to 10 yen
//   total    = unit price × quantity. Every amount is before consumption tax.
// A material or thickness the table has no rate for, or a dimension that is not a number, is
// refused on stderr: it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import * as table from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

const COLUMNS = /** @type {const} */ ({
  material: ['材質', 'material'],
  density: { names: ['比重（g/cm3）', 'density (g/cm3)'], type: 'decimal' },
  pricePerKg: { names: ['材料単価（円/kg）', 'material (yen/kg)'], type: 'whole' },
  yield: { names: ['歩留まり', 'yield'], type: 'decimal' },
  maxThickness: { names: ['板厚上限（mm）', 'max thickness (mm)'], type: 'decimal' },
  cutPerM: { names: ['切断単価（円/m）', 'cutting (yen/m)'], type: 'whole' },
  bendPerHit: { names: ['曲げ単価（円/回）', 'bending (yen/bend)'], type: 'whole' },
  setupPerLot: { names: ['段取り費（円/ロット）', 'setup (yen/lot)'], type: 'whole' },
  margin: { names: ['利益率', 'margin'], type: 'decimal' },
});
const DIMENSIONS = ['length', 'width', 'thickness', 'holes', 'diameter', 'bends', 'quantity'];

export const SPEC = {
  usage: 'estimate.mjs <rates.csv> <material> --length <mm> … --quantity <pieces>',
  positionals: ['rates', 'material'],
  options: Object.fromEntries(DIMENSIONS.map((key) => [key, {}])),
};

// Floating point writes 94.2 as 94.19999…; settle to 6 decimals before any rounding decision.
const settle = (/** @type {number} */ value) => Math.round(value * 1e6) / 1e6;

/**
 * The breakdown of a part of `material` with the dimensions in `options`, from the rate `rows`.
 * @param {string} file the rate table (CSV or .xlsx)
 * @param {string} material
 * @param {Readonly<Partial<Record<string, string>>>} options
 * @throws {table.TableError}
 */
function estimate(file, material, options) {
  const { rows } = table.readTable(file, { columns: COLUMNS });
  const values = DIMENSIONS.map((key) => {
    const value = options[key] ?? '';
    if (!(key === 'quantity' ? /^[1-9]\d*$/u : /^\d+(?:\.\d+)?$/u).test(value))
      throw new table.TableError('usage', `--${key} "${value}" is not a valid ${key}`);
    return Number(value);
  });
  const [length, width, thickness, holes, diameter, bends, quantity] =
    /** @type {[number, number, number, number, number, number, number]} */ (values);
  const fits = rows.filter((row) => row.material === material && thickness <= row.maxThickness);
  const rate = fits.sort((a, b) => a.maxThickness - b.maxThickness)[0];
  if (rate === undefined)
    throw new table.TableError('no_rate', `no ${material} rate for t${String(thickness)}`);
  const kg = (((length * width * thickness) / 1000) * rate.density) / 1000;
  const metres = (2 * (length + width) + holes * Math.PI * diameter) / 1000;
  const breakdown = {
    material: Math.round(settle((kg * rate.pricePerKg) / rate.yield)),
    cutting: Math.round(settle(metres * rate.cutPerM)),
    bending: bends * rate.bendPerHit,
    setup: Math.ceil(settle(rate.setupPerLot / quantity)),
  };
  const cost = Object.values(breakdown).reduce((sum, yen) => sum + yen, 0);
  const unitPrice = Math.ceil(settle(cost * (1 + rate.margin)) / 10) * 10;
  return { material, quantity, breakdown, cost, unitPrice, total: unitPrice * quantity };
}

/** @param {import('@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs').ParsedArgs} args */
export const compute = ({ positionals: p, options }) =>
  estimate(String(p['rates']), String(p['material']), options);

runWhenMain(import.meta.url, SPEC, compute);
