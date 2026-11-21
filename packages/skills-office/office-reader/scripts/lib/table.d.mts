// Types for the table reader (table.mjs), plain JavaScript so it runs with Node alone inside a
// run's sandbox (ADR-0173). Use cases and this package's tests import it through these declarations.

/** A cell as the file holds it: CSV text, or an .xlsx string, number or boolean; `null` is empty. */
export type TableCell = string | number | boolean | null;

/** `date` gives `YYYY-MM-DD` (see {@link dateValue}). */
export type ColumnType = 'text' | 'whole' | 'decimal' | 'date';

/** The header names a column may have; a bare array is a required text column. */
export type ColumnSpec =
  | readonly string[]
  | {
      readonly names: readonly string[];
      readonly type?: ColumnType;
      readonly optional?: boolean;
    };

type ValueOf<S> = S extends { readonly type: 'whole' | 'decimal' } ? number : string;

/** The value a column gives: `number` for whole and decimal, `string` for text, `| null` if optional. */
export type ColumnValue<S> = S extends { readonly optional: true } ? ValueOf<S> | null : ValueOf<S>;

export interface Table<Row> {
  /** The header as written, trimmed. */
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
  /** Where each row is: the file's line (CSV) or the sheet's row (.xlsx), 1-based. */
  readonly rowNumbers: readonly number[];
}

export const TABLE_LIMITS: Readonly<{ fileBytes: number }>;

/** Why a table was refused; `code` is the name an agent reports. */
export class TableError extends Error {
  constructor(
    code: string,
    message: string,
    where?: { readonly row?: number; readonly column?: string; readonly value?: string },
  );
  readonly code: string;
  readonly row?: number;
  readonly column?: string;
  readonly value?: string;
  toJSON(): { error: string; message: string; row?: number; column?: string; value?: string };
}

/**
 * The records of a CSV text (RFC 4180), each with the line it starts on.
 *
 * @throws {TableError} `stray_quote` or `unclosed_quote`.
 */
export function parseCsv(text: string): { line: number; cells: string[] }[];

/** @throws {TableError} `not_a_whole_number`. */
export function wholeNumber(
  value: TableCell,
  where: { readonly row: number; readonly column: string },
): number;

/** @throws {TableError} `not_a_decimal`. */
export function decimalNumber(
  value: TableCell,
  where: { readonly row: number; readonly column: string },
): number;

/**
 * A calendar date, `YYYY-MM-DD`, from text (`2026-09-30`, `2026/9/30`) or a date-styled .xlsx
 * serial day; anything it cannot be sure of is refused.
 *
 * @throws {TableError} `not_a_date`.
 */
export function dateValue(
  value: TableCell,
  where: { readonly row: number; readonly column: string },
  options?: { readonly isDateCell?: boolean; readonly date1904?: boolean },
): string;

/** What an .xlsx says of a cell beyond its value. */
export interface CellMark {
  readonly error?: boolean;
  readonly date?: boolean;
  /** Inside a merged range, but not its top-left cell. */
  readonly merged?: boolean;
}

type Records = readonly {
  readonly line: number;
  readonly cells: readonly TableCell[];
  readonly marks?: readonly (CellMark | undefined)[];
}[];

type Rows<C> = { -readonly [K in keyof C]: ColumnValue<C[K]> };

/** Typed rows from header-and-cells records (`records[0]` is the header). */
export function tableOf<const C extends Readonly<Record<string, ColumnSpec>>>(
  records: Records,
  columns: C,
  options?: { readonly date1904?: boolean },
): Table<Rows<C>>;
export function tableOf(
  records: Records,
  columns?: undefined,
  options?: { readonly date1904?: boolean },
): Table<Record<string, string | null>>;

/**
 * A table from a `.csv` (UTF-8) or `.xlsx` file; the first non-blank row is the header, and an
 * all-blank record is skipped.
 *
 * @throws {TableError}
 */
export function readTable<const C extends Readonly<Record<string, ColumnSpec>>>(
  file: string,
  options: { readonly columns: C; readonly sheet?: string },
): Table<Rows<C>>;
export function readTable(
  file: string,
  options?: { readonly sheet?: string },
): Table<Record<string, string | null>>;
