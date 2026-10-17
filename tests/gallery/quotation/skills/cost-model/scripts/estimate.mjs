#!/usr/bin/env node
/* global process */ // The root ESLint config declares no environment globals.
// The cost model behind the quotation agent: a sheet-metal part's price from its spec and the
// ERP's rate table, with no arithmetic left to the model.
//
//   echo '{"spec": {...}, "rate": {...}}' | node estimate.mjs   → the breakdown as JSON
//   node estimate.mjs quote --spec '<json>' --rate '<json>' [--orders SO-1,SO-2]
//                                                            → the answer's closing block
//
// Per piece:
//   material = L × W × T (mm³) ÷ 1000 → cm³ × density (g/cm³) ÷ 1000 → kg × ¥/kg ÷ yield
//   cutting  = (2 × (L + W) + holes × π × hole diameter) mm ÷ 1000 → m × ¥/m for the thickness
//   bending  = bends × ¥/bend
//   setup    = ¥/lot ÷ quantity
// Rounding (円):
//   1. material, cutting and bending are each rounded to the yen, half up (四捨五入).
//   2. setup is rounded up to the yen (切り上げ), so the lot's setup is always recovered.
//   3. cost = the sum of the four rounded lines.
//   4. unit price = cost × (1 + margin), rounded UP to 10 yen (10円単位切り上げ).
//   5. total = unit price × quantity. Every amount is before consumption tax (税抜).
// The blank is the part's outline; nesting, scrap value and surface finish are not modelled.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MATERIALS = ['SS400', 'SUS304', 'A5052'];

export const ROUNDING =
  '材料費・切断費・曲げ費は1円未満四捨五入、段取り費は数量で割って1円未満切り上げ、単価は10円未満切り上げ、金額は単価×数量。すべて税抜。';

export class EstimateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EstimateError';
  }
}

// Floating point writes 94.2 as 94.19999…; settle to 6 decimals before any rounding decision.
const settle = (value) => Math.round(value * 1e6) / 1e6;
const roundYen = (value) => Math.round(settle(value));
const ceilYen = (value) => Math.ceil(settle(value));
const ceilTen = (value) => Math.ceil(settle(value) / 10) * 10;
const round3 = (value) => Math.round(value * 1000) / 1000;

function positive(record, key, where) {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new EstimateError(`${where}.${key} must be a positive number`);
  }
  return value;
}

function count(record, key, where, { min = 0, max = 1000 } = {}) {
  const value = record[key];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EstimateError(`${where}.${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function object(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EstimateError(`${where} must be an object`);
  }
  return value;
}

/** The spec fields the model reads, checked; anything else on the spec is carried, not used. */
export function readSpec(input) {
  const spec = object(input, 'spec');
  if (!MATERIALS.includes(spec.material)) {
    throw new EstimateError(`spec.material must be one of ${MATERIALS.join(', ')}`);
  }
  const holeCount = count(spec, 'holeCount', 'spec');
  return {
    material: spec.material,
    lengthMm: positive(spec, 'lengthMm', 'spec'),
    widthMm: positive(spec, 'widthMm', 'spec'),
    thicknessMm: positive(spec, 'thicknessMm', 'spec'),
    holeCount,
    holeDiameterMm: holeCount === 0 ? 0 : positive(spec, 'holeDiameterMm', 'spec'),
    bendCount: count(spec, 'bendCount', 'spec', { max: 50 }),
    quantity: count(spec, 'quantity', 'spec', { min: 1, max: 100000 }),
  };
}

function readRate(input, material) {
  const rate = object(input, 'rate');
  if (rate.material !== material) {
    throw new EstimateError(`rate.material is ${String(rate.material)}, the spec is ${material}`);
  }
  const yieldRate = positive(rate, 'yield', 'rate');
  if (yieldRate > 1) throw new EstimateError('rate.yield must be at most 1');
  if (!Array.isArray(rate.cuttingPerMeter) || rate.cuttingPerMeter.length === 0) {
    throw new EstimateError('rate.cuttingPerMeter must be a non-empty list');
  }
  const tiers = rate.cuttingPerMeter
    .map((tier, index) => {
      const where = `rate.cuttingPerMeter[${index}]`;
      const entry = object(tier, where);
      return {
        maxThicknessMm: positive(entry, 'maxThicknessMm', where),
        yenPerMeter: positive(entry, 'yenPerMeter', where),
      };
    })
    .sort((left, right) => left.maxThicknessMm - right.maxThicknessMm);
  const margin = rate.marginRate;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 1) {
    throw new EstimateError('rate.marginRate must be a number from 0 to 1');
  }
  return {
    densityGPerCm3: positive(rate, 'densityGPerCm3', 'rate'),
    pricePerKg: positive(rate, 'pricePerKg', 'rate'),
    yield: yieldRate,
    tiers,
    bendPerHit: positive(rate, 'bendPerHit', 'rate'),
    setupPerLot: positive(rate, 'setupPerLot', 'rate'),
    marginRate: margin,
    effectiveFrom: typeof rate.effectiveFrom === 'string' ? rate.effectiveFrom : null,
  };
}

/**
 * The deterministic estimate for one spec and one rate table. Throws `EstimateError` for an input
 * it cannot price (an unknown material, a thickness beyond the cutting table, a rate for another
 * material) rather than guessing.
 */
export function estimate(specInput, rateInput) {
  const spec = readSpec(specInput);
  const rate = readRate(rateInput, spec.material);
  const tier = rate.tiers.find((entry) => spec.thicknessMm <= entry.maxThicknessMm);
  if (tier === undefined) {
    throw new EstimateError(
      `no cutting rate for ${spec.material} t${spec.thicknessMm}; the table ends at t${rate.tiers.at(-1).maxThicknessMm}`,
    );
  }

  const volumeCm3 = (spec.lengthMm * spec.widthMm * spec.thicknessMm) / 1000;
  const massKg = (volumeCm3 * rate.densityGPerCm3) / 1000;
  const cuttingLengthMm =
    2 * (spec.lengthMm + spec.widthMm) + spec.holeCount * Math.PI * spec.holeDiameterMm;
  const cuttingLengthM = cuttingLengthMm / 1000;

  const material = roundYen((massKg * rate.pricePerKg) / rate.yield);
  const cutting = roundYen(cuttingLengthM * tier.yenPerMeter);
  const bending = roundYen(spec.bendCount * rate.bendPerHit);
  const setup = ceilYen(rate.setupPerLot / spec.quantity);
  const cost = material + cutting + bending + setup;
  const unitPrice = ceilTen(cost * (1 + rate.marginRate));

  return {
    currency: 'JPY',
    taxIncluded: false,
    material: spec.material,
    quantity: spec.quantity,
    perPiece: { material, cutting, bending, setup, cost },
    unitPrice,
    total: unitPrice * spec.quantity,
    basis: {
      massKg: round3(massKg),
      cuttingLengthM: round3(cuttingLengthM),
      cuttingYenPerMeter: tier.yenPerMeter,
      pricePerKg: rate.pricePerKg,
      yield: rate.yield,
      bendPerHit: rate.bendPerHit,
      setupPerLot: rate.setupPerLot,
      marginRate: rate.marginRate,
      rateEffectiveFrom: rate.effectiveFrom,
    },
    rounding: ROUNDING,
  };
}

/**
 * The answer's closing block, ready to paste: the line 類似実績なし when no similar order was read,
 * then the fenced JSON the backend parses. The model pastes it unchanged, so the numbers keep the
 * script's own formatting.
 */
export function answerBlock(spec, rate, orders = []) {
  const block = { breakdown: estimate(spec, rate), similarOrders: orders };
  return [
    ...(orders.length === 0 ? ['類似実績なし', ''] : []),
    '```json',
    JSON.stringify(block, null, 2),
    '```',
  ].join('\n');
}

// ---------- command line ----------

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const quote = process.argv[2] === 'quote';
  let input;
  try {
    if (quote) {
      input = { spec: JSON.parse(option('spec') ?? ''), rate: JSON.parse(option('rate') ?? '') };
    } else {
      input = JSON.parse(readFileSync(0, 'utf8'));
    }
  } catch {
    process.stderr.write(
      quote
        ? "usage: node estimate.mjs quote --spec '<json>' --rate '<json>' [--orders SO-1,SO-2]\n"
        : 'usage: echo \'{"spec": {...}, "rate": {...}}\' | node estimate.mjs\n',
    );
    process.exit(2);
  }
  try {
    if (quote) {
      const orders = (option('orders') ?? '')
        .split(',')
        .map((order) => order.trim())
        .filter((order) => order !== '');
      process.stdout.write(`${answerBlock(input.spec, input.rate, orders)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(estimate(input?.spec, input?.rate), null, 2)}\n`);
    }
  } catch (error) {
    if (!(error instanceof EstimateError)) throw error;
    process.stderr.write(`estimate refused: ${error.message}\n`);
    process.exit(1);
  }
}
