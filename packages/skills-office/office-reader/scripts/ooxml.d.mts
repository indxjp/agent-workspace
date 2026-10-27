// Types for the office-reader skill's script, which is plain JavaScript so it runs with Node alone
// inside a run's sandbox. The tests import it through these declarations.
export type CellValue = string | number | boolean;

export interface XlsxSheet {
  readonly name: string;
  /** Dense rows; every cell of a merged range repeats the range's top-left value. */
  readonly rows: (CellValue | null)[][];
  readonly merges: readonly string[];
  /** Non-empty cells by reference as written, such as `B3`. */
  readonly cells: Readonly<Record<string, CellValue>>;
}

export interface DocxParagraph {
  readonly style: string | null;
  readonly text: string;
}

export const OOXML_LIMITS: Readonly<{
  fileBytes: number;
  entries: number;
  entryBytes: number;
  totalBytes: number;
}>;

export class OoxmlRefusal extends Error {
  readonly code: 'archive_too_large' | 'too_many_entries' | 'entry_too_large' | 'corrupt_archive';
}

export function readZip(buffer: Buffer): Map<string, Buffer>;
export function writeZip(
  entries: readonly { readonly name: string; readonly data: string | Buffer }[],
): Buffer;
export function columnIndex(letters: string): number;
export function columnLetters(index: number): string;
export function readXlsx(buffer: Buffer): { sheets: XlsxSheet[] };
export function writeXlsx(workbook: {
  readonly sheets: readonly {
    readonly name: string;
    readonly rows: readonly (readonly (CellValue | null)[])[];
    readonly merges?: readonly string[];
  }[];
}): Buffer;
export function readDocx(buffer: Buffer): { paragraphs: DocxParagraph[] };
export function writeDocx(document: {
  readonly paragraphs: readonly { readonly style?: string; readonly text: string }[];
}): Buffer;
