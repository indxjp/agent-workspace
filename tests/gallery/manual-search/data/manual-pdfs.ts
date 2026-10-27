/**
 * The manuals as the maintenance department really receives them: PDF. Each `manuals/<name>.pdf` is
 * written from the page-marked `manuals/<name>.md` beside it (`GALLERY_WRITE=1` regenerates them);
 * the Markdown stays as the page-marked source and the second searchable copy.
 *
 * One PDF page per marked page, with a running header (title and code) and the printed page number
 * in the footer (`p.12`), the way a manual carries its citation. Japanese is shown through an
 * Identity-H font with a ToUnicode map, which is how office suites export it. The streams are not
 * compressed so the bytes do not depend on the zlib version. The font is not embedded: the file is
 * for text extraction, not for printing.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ManualPage {
  readonly number: number;
  /** The text lines of the page, header and footer included, as a reader returns them. */
  readonly lines: readonly string[];
}

/** The pages of a manual in the page-marked Markdown. */
export function manualPages(markdown: string): ManualPage[] {
  const title = /^title: (.+)$/mu.exec(markdown)?.[1] ?? '';
  const code = /^code: (.+)$/mu.exec(markdown)?.[1] ?? '';
  const [, ...marked] = markdown.split(/^<!-- page (\d+) -->$/mu);
  const pages: ManualPage[] = [];
  for (let at = 0; at < marked.length; at += 2) {
    const number = Number(marked[at]);
    const body = (marked[at + 1] ?? '')
      .split('\n')
      .map((line) => line.replace(/^## /u, '').trim())
      .filter((line) => line !== '');
    pages.push({ number, lines: [`${title} ${code}`, ...body, `p.${String(number)}`] });
  }
  return pages;
}

const hex4 = (code: number): string => code.toString(16).padStart(4, '0');

/** `<0001…>`: the font codes of `text`, one per character. */
function shown(text: string, codes: ReadonlyMap<string, number>): string {
  return `<${[...text].map((char) => hex4(codes.get(char) ?? 0)).join('')}>`;
}

function toUnicode(codes: ReadonlyMap<string, number>): string {
  // Destinations are UTF-16BE: a character outside the BMP is its surrogate pair.
  const entries = [...codes].map(([char, code]) => {
    const units = [...Array(char.length).keys()].map((at) => hex4(char.charCodeAt(at))).join('');
    return `<${hex4(code)}> <${units}>`;
  });
  const blocks: string[] = [];
  for (let at = 0; at < entries.length; at += 100) {
    const chunk = entries.slice(at, at + 100);
    blocks.push(`${String(chunk.length)} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    ...blocks,
    'endcmap end end',
  ].join('\n');
}

const stream = (body: string): string =>
  `<< /Length ${String(body.length)} >>\nstream\n${body}\nendstream`;

/** The PDF of one page-marked manual; deterministic, so a test can compare bytes. */
export function manualPdf(markdown: string): Buffer {
  const pages = manualPages(markdown);
  const chars = [...new Set(pages.flatMap((page) => [...page.lines.join('')]))].toSorted();
  const codes = new Map(chars.map((char, index) => [char, index + 1]));
  const pageObjects = pages.flatMap((page, index) => {
    const lines = page.lines.map((line) => `${shown(line, codes)} Tj`);
    const content = `BT /F1 11 Tf 56 780 Td ${lines.join(' 0 -16 Td ')} ET`;
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(7 + index * 2)} 0 R >>`,
      stream(content),
    ];
  });
  const kids = pages.map((_, index) => `${String(6 + index * 2)} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Gothic /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Gothic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>',
    stream(toUnicode(codes)),
    ...pageObjects,
  ];

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Write `<name>.pdf` beside every `<name>.md` in `dir`. */
export function writeManualPdfs(dir: string): void {
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.md'))) {
    writeFileSync(
      path.join(dir, name.replace(/\.md$/u, '.pdf')),
      manualPdf(readFileSync(path.join(dir, name), 'utf8')),
    );
  }
}
