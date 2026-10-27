/**
 * The office-reader skill's PDF script, run as an agent runs it: under `node --permission` with read
 * access to the file's directory only. The PDFs are built here, by hand, from `zlib` and strings.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { PDF_LIMITS, PdfRefusal, readPdf } from '../office-reader/scripts/pdf.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'office-reader',
  'scripts',
  'pdf.mjs',
);
const run = promisify(execFile);

function stream(dict: string, data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

const flate = (text: string) =>
  stream('/Filter /FlateDecode', deflateSync(Buffer.from(text, 'latin1')));

/** A PDF of the given objects (object 1 is the catalog) and a trailer with `trailer` entries. */
function build(objects: Record<number, string | Buffer>, trailer = ''): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  for (const [id, body] of Object.entries(objects))
    parts.push(
      Buffer.from(`${id} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n', 'latin1'),
    );
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R ${trailer} >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

async function runScript(
  content: Buffer,
): Promise<{ stdout: string } | { code: number; stderr: string; stdout: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pdf-'));
  const file = path.join(dir, 'in.pdf');
  await writeFile(file, content);
  try {
    return await run(process.execPath, ['--permission', `--allow-fs-read=${dir}`, SCRIPT, file]);
  } catch (error) {
    const { code, stderr, stdout } = error as { code: number; stderr: string; stdout: string };
    return { code, stderr, stdout };
  }
}

describe('office-reader pdf.mjs', () => {
  it('reads an uncompressed page, with escapes and line breaks', () => {
    const pdf = build({
      1: CATALOG,
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      4: HELVETICA,
      5: stream(
        '',
        'BT /F1 12 Tf 72 720 Td (Invoice \\(draft\\) \\101) Tj 0 -14 Td [(Total) -400 (1,200)] TJ ET',
      ),
    });
    expect(readPdf(pdf)).toStrictEqual({
      pages: [{ number: 1, text: 'Invoice (draft) A\nTotal 1,200' }],
    });
  });

  it('reads compressed pages in page-tree order, inheriting resources', () => {
    const pdf = build({
      1: CATALOG,
      2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>',
      3: '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
      4: '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
      5: HELVETICA,
      6: flate('BT /F1 12 Tf (first page) Tj ET'),
      7: flate('BT /F1 12 Tf (second page) Tj ET'),
    });
    expect(readPdf(pdf).pages.map((page) => page.text)).toStrictEqual([
      'first page',
      'second page',
    ]);
  });

  it('finds objects packed in an object stream', () => {
    const packed = [
      CATALOG,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      HELVETICA,
    ];
    let offset = 0;
    const header = packed
      .map((body, index) => {
        const entry = `${index + 1} ${offset}`;
        offset += body.length + 1;
        return entry;
      })
      .join(' ');
    const pdf = build({
      6: stream(
        `/Type /ObjStm /N ${packed.length} /First ${header.length + 1} /Filter /FlateDecode`,
        deflateSync(Buffer.from(`${header}\n${packed.join('\n')}`, 'latin1')),
      ),
      5: flate('BT /F1 12 Tf (packed) Tj ET'),
    });
    expect(readPdf(pdf).pages.map((page) => page.text)).toStrictEqual(['packed']);
  });

  it('reads Japanese from an Identity-H font through its ToUnicode map', () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar <0001> <65E5> <0002> <672C> endbfchar',
      '1 beginbfrange <0003> <0004> <8A9E> endbfrange',
      '1 beginbfrange <0005> <0006> [<8AAD> <3002>] endbfrange',
      'endcmap end end',
    ].join('\n');
    const pdf = build({
      1: CATALOG,
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      4: '<< /Type /Font /Subtype /Type0 /BaseFont /Gothic /Encoding /Identity-H /ToUnicode 6 0 R >>',
      5: flate('BT /F1 12 Tf <000100020003000400050006> Tj ET'),
      6: flate(cmap),
    });
    expect(readPdf(pdf).pages[0]).toStrictEqual({ number: 1, text: '日本語誟読。' });
  });

  it('returns "" for an image-only page and flags a composite font it cannot decode', () => {
    const image = build({
      1: CATALOG,
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
      4: stream('', 'q 595 0 0 842 0 0 cm /Im1 Do Q'),
    });
    expect(readPdf(image).pages).toStrictEqual([{ number: 1, text: '' }]);

    const opaque = build({
      1: CATALOG,
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      4: '<< /Type /Font /Subtype /Type0 /BaseFont /Gothic /Encoding /Identity-H >>',
      5: stream('', 'BT /F1 12 Tf <0001> Tj ET'),
    });
    expect(readPdf(opaque).pages).toStrictEqual([{ number: 1, text: '', unreadable: true }]);
  });

  it('refuses a password-protected PDF by name, with no text', async () => {
    const pdf = build(
      {
        1: CATALOG,
        2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
        4: stream('', 'BT (secret) Tj ET'),
        5: '<< /Filter /Standard /V 2 /R 3 /O (x) /U (y) /P -4 >>',
      },
      '/Encrypt 5 0 R',
    );
    expect(() => readPdf(pdf)).toThrow(PdfRefusal);
    const result = await runScript(pdf);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse((result as { stderr: string }).stderr)).toMatchObject({
      error: 'encrypted_pdf',
    });
  });

  it('refuses a file that is not a PDF', async () => {
    const result = await runScript(Buffer.from('PK\u0003\u0004 not a pdf'));
    expect(result).toMatchObject({ code: 1 });
    expect(JSON.parse((result as { stderr: string }).stderr)).toMatchObject({
      error: 'not_a_pdf',
    });
  });

  it('refuses a PDF with no readable page tree instead of reading it as empty', async () => {
    const result = await runScript(Buffer.from('%PDF-1.7\n\u0000\u00ff garbage, no objects'));
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse((result as { stderr: string }).stderr)).toMatchObject({
      error: 'corrupt_pdf',
    });
  });

  it('runs under the permission model and prints JSON', async () => {
    const result = await runScript(
      build({
        1: CATALOG,
        2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        4: HELVETICA,
        5: stream('', 'BT /F1 12 Tf (ok) Tj ET'),
      }),
    );
    expect(JSON.parse(result.stdout)).toStrictEqual({ pages: [{ number: 1, text: 'ok' }] });
  });

  describe('limits on an untrusted file', () => {
    // The inflate caps are injected small, so a cap is proven by a small file, not a 64 MiB one.
    const small = { ...PDF_LIMITS, streamBytes: 1024 * 1024, inflatedBytes: 4 * 1024 * 1024 };
    const refusalOf = (pdf: Buffer): string | undefined => {
      try {
        readPdf(pdf, small);
      } catch (error) {
        return error instanceof PdfRefusal ? error.code : String(error);
      }
      return undefined;
    };
    // A comment is skipped without being parsed, so inflating the bomb is the only cost.
    const bomb = (size: number) => {
      const data = Buffer.alloc(size, 0x61);
      data[0] = 0x25;
      return stream('/Filter /FlateDecode', deflateSync(data));
    };
    const onePage = (content: Buffer) =>
      build({
        1: CATALOG,
        2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
        4: content,
      });

    it('refuses a stream that inflates past the stream cap', () => {
      expect(refusalOf(onePage(bomb(small.streamBytes + 1)))).toBe('stream_too_large');
    });

    it('refuses streams that inflate past the total cap together, one page at a time', () => {
      const pages = 6;
      const kids = Array.from({ length: pages }, (_, index) => `${index + 10} 0 R`).join(' ');
      const objects: Record<number, string | Buffer> = {
        1: CATALOG,
        2: `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
        4: bomb(small.streamBytes - 64 * 1024),
      };
      for (let index = 0; index < pages; index += 1)
        objects[index + 10] = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>';
      expect(refusalOf(build(objects))).toBe('inflated_too_large');
    });

    it('refuses an object stream that inflates past the stream cap', () => {
      const packed = build({
        1: CATALOG,
        2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3: '<< /Type /Page /Parent 2 0 R >>',
        5: stream(
          '/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode',
          deflateSync(Buffer.alloc(small.streamBytes + 1)),
        ),
      });
      expect(refusalOf(packed)).toBe('stream_too_large');
    });

    it('refuses more pages than the page cap', () => {
      const count = PDF_LIMITS.pages + 1;
      const kids = Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(' ');
      const objects: Record<number, string | Buffer> = {
        1: CATALOG,
        2: `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
      };
      for (let index = 0; index < count; index += 1)
        objects[index + 3] = '<< /Type /Page /Parent 2 0 R >>';
      expect(refusalOf(build(objects))).toBe('too_many_pages');
    });

    it('refuses a page tree nested past the depth cap, not with a stack overflow', () => {
      const depth = 20_000;
      const objects: Record<number, string | Buffer> = { 1: CATALOG };
      for (let index = 0; index < depth; index += 1)
        objects[index + 2] = `<< /Type /Pages /Kids [${index + 3} 0 R] /Count 1 >>`;
      objects[depth + 2] = '<< /Type /Page >>';
      expect(refusalOf(build(objects))).toBe('page_tree_too_deep');
    });

    it('refuses more objects than the object cap', () => {
      const objects = Array.from(
        { length: PDF_LIMITS.objects + 1 },
        (_, index) => `${index + 1} 0 obj 1 endobj`,
      );
      expect(refusalOf(Buffer.from(`%PDF-1.7\n${objects.join('\n')}\n`, 'latin1'))).toBe(
        'too_many_objects',
      );
    });

    it('refuses a file past the file-size cap, in memory and before the command reads it', async () => {
      expect(refusalOf(Buffer.alloc(PDF_LIMITS.fileBytes + 1))).toBe('file_too_large');
      const dir = await mkdtemp(path.join(tmpdir(), 'pdf-big-'));
      const file = path.join(dir, 'big.pdf');
      await writeFile(file, '');
      await truncate(file, PDF_LIMITS.fileBytes + 1);
      await expect(
        run(process.execPath, ['--permission', `--allow-fs-read=${dir}`, SCRIPT, file]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('"error":"file_too_large"') as string,
      });
    });
  });
});
