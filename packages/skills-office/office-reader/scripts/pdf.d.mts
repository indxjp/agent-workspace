// Types for the office-reader skill's PDF script, plain JavaScript so it runs with Node alone.
export interface PdfPage {
  readonly number: number;
  /** One line per run of text on the page; `""` for a page with none (a scan; there is no OCR). */
  readonly text: string;
  /** Set when the page has text this script could not decode. */
  readonly unreadable?: true;
}

export class PdfRefusal extends Error {
  readonly code:
    | 'not_a_pdf'
    | 'encrypted_pdf'
    | 'corrupt_pdf'
    | 'file_too_large'
    | 'too_many_objects'
    | 'too_many_pages'
    | 'page_tree_too_deep'
    | 'stream_too_large'
    | 'inflated_too_large';
}

export const PDF_LIMITS: Readonly<{
  fileBytes: number;
  objects: number;
  pages: number;
  pageTreeDepth: number;
  streamBytes: number;
  inflatedBytes: number;
}>;

export function readPdf(
  buffer: Buffer,
  limits?: { streamBytes: number; inflatedBytes: number },
): { pages: PdfPage[] };
