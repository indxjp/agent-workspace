/**
 * Plain text out of a workspace file, for search (ADR-0147, P8-4).
 *
 * The readers are the office-reader skill's own scripts, the ones an agent runs through
 * `run_skill_script`, so search and a run read a PDF, workbook, document or drawing the same way.
 * Extraction is lexical text only: no OCR, so a scanned PDF yields no passages.
 */
import { readDxf } from '@agent-workspace/skills-office/office-reader/scripts/dxf.mjs';
import { readDocx, readXlsx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { readPdf } from '@agent-workspace/skills-office/office-reader/scripts/pdf.mjs';

/** One searchable stretch of a file; `page` is a PDF page or a sheet's 1-based ordinal. */
export interface ExtractedPassage {
  readonly page: number | null;
  readonly text: string;
}

export type ExtractKind = 'pdf' | 'xlsx' | 'docx' | 'dxf' | 'text';

/** The most bytes of one file a search request reads and parses in-process. */
export const EXTRACT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The most passages kept per file; a longer file is indexed up to here. */
const MAX_PASSAGES = 2_000;

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'vtt', 'json']);

/** Which reader handles this file, or `null` when search has none for it. */
export function extractKind(path: string, contentType: string | null): ExtractKind | null {
  const extension = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'xlsx') return 'xlsx';
  if (extension === 'docx') return 'docx';
  if (extension === 'dxf') return 'dxf';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return contentType?.toLowerCase().startsWith('text/') === true ? 'text' : null;
}

/**
 * The passages of `bytes`, each at most `maxChars` long. Throws whatever the reader throws for a
 * file it refuses (`PdfRefusal`, `OoxmlRefusal`, `DxfRefusal`) or cannot parse; the caller records
 * that as a marker and does not retry the same version of the file.
 */
export function extractPassages(
  kind: ExtractKind,
  bytes: Uint8Array,
  maxChars: number,
): ExtractedPassage[] {
  const buffer = Buffer.from(bytes);
  const raw: ExtractedPassage[] = [];
  switch (kind) {
    case 'pdf':
      for (const page of readPdf(buffer).pages) raw.push({ page: page.number, text: page.text });
      break;
    case 'xlsx':
      readXlsx(buffer).sheets.forEach((sheet, index) => {
        const rows = sheet.rows.map((row) => row.map((cell) => cell ?? '').join('\t'));
        raw.push({ page: index + 1, text: [sheet.name, ...rows].join('\n') });
      });
      break;
    case 'docx':
      raw.push({
        page: null,
        text: readDocx(buffer)
          .paragraphs.map((paragraph) => paragraph.text)
          .join('\n'),
      });
      break;
    case 'dxf':
      raw.push({
        page: null,
        text: readDxf(buffer)
          .texts.filter((entity) => entity.type === 'TEXT' || entity.type === 'MTEXT')
          .map((entity) => entity.text)
          .join('\n'),
      });
      break;
    case 'text':
      raw.push({ page: null, text: buffer.toString('utf8') });
      break;
  }

  const passages: ExtractedPassage[] = [];
  for (const { page, text } of raw) {
    // PostgreSQL text cannot hold a NUL, and a PDF or drawing can.
    const clean = text.replaceAll('\u0000', ' ').trim();
    for (let start = 0; start < clean.length && passages.length < MAX_PASSAGES; start += maxChars) {
      const piece = clean.slice(start, start + maxChars).trim();
      if (piece !== '') passages.push({ page, text: piece });
    }
  }
  return passages;
}
