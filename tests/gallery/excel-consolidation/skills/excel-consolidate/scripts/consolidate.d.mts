// Types for the excel-consolidate skill's script, which is plain JavaScript so it runs with Node
// alone inside a run's sandbox. The tests and the backend import it through these declarations.
export type Unit = '円' | '千円' | '百万円';
export type DateFormat = 'wareki' | 'ymd' | 'serial';
export type Field = 'date' | 'category' | 'amount';
export type CellValue = string | number | boolean;

export interface Layout {
  readonly branch: string;
  readonly files: readonly string[];
  readonly sheet: string;
  /** 1-based; data starts on the row after the last one. */
  readonly headerRows: readonly number[];
  readonly columns: Readonly<Record<Field, string>>;
  readonly unit: Unit;
  readonly dateFormat: DateFormat;
  /** A row whose date or category cell starts with one of these is left out (小計, 合計, ※). */
  readonly skip?: readonly string[];
}

export interface Plan {
  readonly layouts: readonly Layout[];
}

export interface Book {
  readonly sheets: readonly {
    readonly name: string;
    readonly rows: readonly (readonly (CellValue | null)[])[];
    readonly merges: readonly string[];
  }[];
}

export interface Row {
  readonly branch: string;
  readonly date: string;
  readonly month: string;
  readonly category: string | null;
  /** In yen. */
  readonly amount: number;
  readonly raw: { readonly amount: number; readonly unit: Unit };
  /** `file!sheet!cell` of each value. */
  readonly '@src': Readonly<Record<Field, string>>;
}

export interface Applied {
  readonly branches: readonly string[];
  readonly rows: readonly Row[];
  /** Month (YYYY-MM) → branch → yen. */
  readonly totals: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly skipped: readonly {
    readonly src: string;
    readonly reason: string;
    readonly text: string;
  }[];
}

export interface Change {
  readonly previous: number;
  readonly current: number;
  readonly diff: number;
  /** Percent, one decimal; null when the previous month is zero. */
  readonly pct: number | null;
}

export interface Report extends Applied {
  readonly comparison: {
    readonly from: string;
    readonly to: string;
    readonly branches: readonly (Change & { readonly branch: string })[];
    readonly total: Change;
  };
}

export const UNITS: Readonly<Record<Unit, number>>;
export const DATE_FORMATS: readonly DateFormat[];
export const FIELDS: readonly Field[];
export class PlanError extends Error {}
export function warekiToIso(text: string): string;
export function serialToIso(serial: number): string;
export function ymdToIso(text: string): string;
export function parseDate(value: CellValue | null, format: DateFormat): string;
export function unitInLabel(label: string): Unit | null;
export function applyPlan(plan: Plan, books: Readonly<Record<string, Book>>): Applied;
export function compare(applied: Applied, from: string, to: string): Report;
export function detectUnit(
  sheet: Book['sheets'][number],
  count?: number,
): { unit: Unit; cell: string; text: string } | null;
export function inspect(
  book: Book,
  count?: number,
): {
  sheet: string;
  /** The unit the sheet states (a 単位 row first, then a header label), or null. */
  unit: Unit | null;
  /** `<cell> <text>` of what states it, or null. */
  unitFrom: string | null;
  merges: readonly string[];
  rowCount: number;
  rows: { row: number; cells: Record<string, CellValue> }[];
}[];
