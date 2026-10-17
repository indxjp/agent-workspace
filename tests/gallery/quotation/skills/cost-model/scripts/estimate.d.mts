// Types for the cost-model skill's script, which is plain JavaScript so it runs with Node alone
// inside a run's sandbox. The tests and the backend import it through these declarations.
export type Material = 'SS400' | 'SUS304' | 'A5052';

export const MATERIALS: readonly Material[];
export const ROUNDING: string;

export class EstimateError extends Error {}

/** A customer's part, as sales enters it from the drawing. Extra keys are carried, not used. */
export interface PartSpec {
  readonly material: Material;
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly thicknessMm: number;
  readonly holeCount: number;
  /** Required when `holeCount` is above 0. */
  readonly holeDiameterMm?: number;
  readonly bendCount: number;
  readonly quantity: number;
  readonly [key: string]: unknown;
}

/** One material's rates, as the ERP's `GET /rates/{material}` returns them. */
export interface RateTable {
  readonly material: Material;
  readonly densityGPerCm3: number;
  readonly pricePerKg: number;
  readonly yield: number;
  readonly cuttingPerMeter: readonly {
    readonly maxThicknessMm: number;
    readonly yenPerMeter: number;
  }[];
  readonly bendPerHit: number;
  readonly setupPerLot: number;
  readonly marginRate: number;
  readonly effectiveFrom?: string;
  readonly [key: string]: unknown;
}

export interface Estimate {
  readonly currency: 'JPY';
  readonly taxIncluded: false;
  readonly material: Material;
  readonly quantity: number;
  readonly perPiece: {
    readonly material: number;
    readonly cutting: number;
    readonly bending: number;
    readonly setup: number;
    readonly cost: number;
  };
  readonly unitPrice: number;
  readonly total: number;
  readonly basis: {
    readonly massKg: number;
    readonly cuttingLengthM: number;
    readonly cuttingYenPerMeter: number;
    readonly pricePerKg: number;
    readonly yield: number;
    readonly bendPerHit: number;
    readonly setupPerLot: number;
    readonly marginRate: number;
    readonly rateEffectiveFrom: string | null;
  };
  readonly rounding: string;
}

export function readSpec(input: unknown): PartSpec;
export function estimate(spec: unknown, rate: unknown): Estimate;

/** The closing block of an answer: 類似実績なし when `orders` is empty, then the fenced JSON. */
export function answerBlock(spec: unknown, rate: unknown, orders?: readonly string[]): string;
