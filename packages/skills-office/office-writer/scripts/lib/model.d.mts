// Types for the office-writer model (model.mjs), plain JavaScript so it runs with Node alone inside
// a run's sandbox. The tests import it through these declarations (ADR-0167 D2).
export type OfficeFormat = 'docx' | 'pptx' | 'xlsx';

/** A Word or slide table: every row as wide as the header, or as the first row without one. */
export interface TableModel {
  readonly header?: readonly string[];
  readonly rows: readonly (readonly (string | number)[])[];
}

export type DocxBlock =
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'list'; readonly ordered?: boolean; readonly items: readonly string[] }
  | ({ readonly type: 'table' } & TableModel);

export interface DocxModel {
  readonly format: 'docx';
  readonly title?: string;
  readonly blocks: readonly DocxBlock[];
}

export interface PptxModel {
  readonly format: 'pptx';
  readonly slides: readonly {
    readonly title: string;
    readonly bullets?: readonly string[];
    readonly table?: TableModel;
  }[];
}

/** A cell: a date is a day written `YYYY-MM-DD`, from 1900-03-01. */
export type XlsxCell = string | number | boolean | null | { readonly date: string };

export interface XlsxModel {
  readonly format: 'xlsx';
  readonly sheets: readonly {
    readonly name: string;
    readonly header?: readonly XlsxCell[];
    readonly rows: readonly (readonly XlsxCell[])[];
  }[];
}

export type OfficeModel = DocxModel | PptxModel | XlsxModel;

export interface ModelIssue {
  /** Where, as a JSON path from `$`, such as `$.slides[2].table.rows[0]`. */
  readonly path: string;
  readonly message: string;
}

export const OFFICE_WRITER_LIMITS: Readonly<{
  modelBytes: number;
  textLength: number;
  blocks: number;
  listItems: number;
  tableRows: number;
  tableColumns: number;
  slides: number;
  bullets: number;
  slideTableRows: number;
  slideTableColumns: number;
  sheets: number;
  sheetColumns: number;
  cells: number;
  reportedIssues: number;
}>;

export const OFFICE_FORMATS: readonly OfficeFormat[];

export type OfficeWriterRefusalCode =
  | 'invalid_model'
  | 'invalid_json'
  | 'unreadable_model'
  | 'model_too_large'
  | 'extension_mismatch'
  | 'output_exists'
  | 'output_not_writable';

export class OfficeWriterRefusal extends Error {
  constructor(code: OfficeWriterRefusalCode, message: string, issues?: readonly ModelIssue[]);
  readonly code: OfficeWriterRefusalCode;
  readonly issues: readonly ModelIssue[];
  toJSON(): { error: OfficeWriterRefusalCode; message: string; issues?: readonly ModelIssue[] };
}

/** @throws {OfficeWriterRefusal} `invalid_model`, with the issues found. */
export function parseModel(value: unknown): OfficeModel;
