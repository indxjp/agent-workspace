// Types for the office-reader skill's DXF script, plain JavaScript so it runs with Node alone.
export interface DxfText {
  readonly type: 'TEXT' | 'MTEXT' | 'ATTRIB' | 'ATTDEF' | 'DIMENSION';
  readonly layer?: string;
  /** The block definition the entity sits in; absent for the drawing's own entities. */
  readonly block?: string;
  /** The attribute tag of an `ATTRIB` or `ATTDEF`. */
  readonly tag?: string;
  readonly text: string;
  /** The text height of a `TEXT`, `MTEXT`, `ATTRIB` or `ATTDEF`, in drawing units. */
  readonly height?: number;
  /** A dimension's measured value. */
  readonly measurement?: number;
  readonly x?: number;
  readonly y?: number;
}

export interface DxfInsert {
  readonly name: string;
  readonly layer?: string;
  readonly block?: string;
  readonly x?: number;
  readonly y?: number;
}

/** A `LINE`, from `(x1, y1)` to `(x2, y2)`. */
export interface DxfLine {
  readonly layer?: string;
  readonly block?: string;
  readonly x1?: number;
  readonly y1?: number;
  readonly x2?: number;
  readonly y2?: number;
}

/** A `CIRCLE` with centre `(x, y)` and radius `r`. */
export interface DxfCircle {
  readonly layer?: string;
  readonly block?: string;
  readonly x?: number;
  readonly y?: number;
  readonly r?: number;
}

export interface DxfDrawing {
  readonly version: string | null;
  readonly codepage: string | null;
  readonly layers: string[];
  readonly blocks: string[];
  /** How many entities of each type the drawing and its blocks hold. */
  readonly counts: Record<string, number>;
  readonly texts: DxfText[];
  readonly inserts: DxfInsert[];
  /** Every `LINE`; no other shape has its coordinates read. */
  readonly lines: DxfLine[];
  /** Every `CIRCLE`. */
  readonly circles: DxfCircle[];
}

export class DxfRefusal extends Error {
  readonly code: 'binary_dxf' | 'unsupported_codepage' | 'not_a_dxf' | 'file_too_large';
}

export const DXF_MAX_FILE_BYTES: number;

export function readDxf(buffer: Buffer): DxfDrawing;
