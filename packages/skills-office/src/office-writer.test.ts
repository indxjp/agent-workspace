/**
 * The office-writer skill's script (ADR-0167): each file it writes read back through office-reader,
 * the package parts the applications require, and the command an agent runs, with its refusals.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readDocx, readXlsx, readZip } from '../office-reader/scripts/ooxml.mjs';
import type { DocxModel, PptxModel, XlsxModel } from '../office-writer/scripts/lib/model.mjs';
import { buildOfficeFile, main, saveNewFile } from '../office-writer/scripts/write.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'office-writer',
  'scripts',
  'write.mjs',
);
const run = promisify(execFile);

const DOCUMENT: DocxModel = {
  format: 'docx',
  title: '作業手順書',
  blocks: [
    { type: 'heading', level: 1, text: '第1章 目的' },
    { type: 'paragraph', text: '本書は <検査> & "出荷" の手順を定める。\n二行目。' },
    { type: 'list', items: ['安全靴', '保護眼鏡'] },
    { type: 'list', ordered: true, items: ['電源を切る', '表示灯を確認する'] },
    { type: 'heading', level: 2, text: '1.1 範囲' },
    { type: 'list', ordered: true, items: ['再開する'] },
    {
      type: 'table',
      header: ['工程', '時間（分）'],
      rows: [
        ['組立', 30],
        ['検査', 12.5],
      ],
    },
    { type: 'table', rows: [['備考', '']] },
  ],
};

const DECK: PptxModel = {
  format: 'pptx',
  slides: [
    { title: '提案の概要', bullets: ['課題: 月次集計が手作業', '効果: 月20時間の削減\n（試算）'] },
    {
      title: '費用',
      bullets: ['初期費用なし'],
      table: {
        header: ['項目', '金額（円）'],
        rows: [
          ['月額', 50_000],
          ['保守', '込み'],
        ],
      },
    },
    { title: '体制', table: { rows: [['PM', '山田（架空）']] } },
    { title: 'ご清聴ありがとうございました' },
  ],
};

const WORKBOOK: XlsxModel = {
  format: 'xlsx',
  sheets: [
    {
      name: '売上',
      header: ['拠点', '売上（千円）', '達成', '締め日'],
      rows: [
        ['東京', 1200, true, { date: '2026-11-30' }],
        ['大阪', null, false, { date: '1900-03-01' }],
        ['名古屋 & <支店>', -3.25, null, null],
      ],
    },
    { name: 'Notes', rows: [['repeated'], ['repeated']] },
  ],
};

/** The XML parts are well formed: every element closes in order, every `&` starts an entity. */
function expectWellFormed(name: string, xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), name).toBe(
    true,
  );
  const open: string[] = [];
  for (const [tag] of xml.matchAll(/<[^>]+>/gu)) {
    if (tag.startsWith('<?') || tag.endsWith('/>')) continue;
    const element = /^<\/?([\w:]+)/u.exec(tag)?.[1] ?? '';
    if (tag.startsWith('</'))
      expect(open.pop(), `${name}: ${element} closes in order`).toBe(element);
    else open.push(element);
  }
  expect(open, `${name} closes every element`).toStrictEqual([]);
  expect(xml.replace(/&(?:amp|lt|gt|quot|#\d+);/gu, ''), name).not.toMatch(/[&]/u);
}

/** Every part `[Content_Types].xml` names and every relationship target is in the package. */
function expectCompletePackage(file: Buffer): Map<string, string> {
  const parts = new Map([...readZip(file)].map(([name, data]) => [name, data.toString('utf8')]));
  for (const [name, xml] of parts) expectWellFormed(name, xml);
  const types = parts.get('[Content_Types].xml') ?? '';
  for (const [, part] of types.matchAll(/PartName="\/([^"]+)"/gu))
    expect(parts.has(part ?? '')).toBe(true);
  for (const [name, xml] of parts) {
    if (!name.endsWith('.rels')) continue;
    const base = path.posix.dirname(path.posix.dirname(name));
    for (const [, target] of xml.matchAll(/Target="([^"]+)"/gu))
      expect(
        parts.has(path.posix.normalize(path.posix.join(base, target ?? ''))),
        `${name} → ${target}`,
      ).toBe(true);
  }
  return parts;
}

const slideTexts = (parts: Map<string, string>) =>
  [...parts]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([, xml]) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/gu)].map((match) => match[1]));

describe('office-writer', () => {
  it('writes a Word file whose headings, paragraphs, lists and table cells read back', () => {
    const file = buildOfficeFile(DOCUMENT);
    const parts = expectCompletePackage(file);
    expect(readDocx(file).paragraphs).toStrictEqual([
      { style: 'Title', text: '作業手順書' },
      { style: 'Heading1', text: '第1章 目的' },
      { style: null, text: '本書は <検査> & "出荷" の手順を定める。二行目。' },
      { style: 'ListParagraph', text: '安全靴' },
      { style: 'ListParagraph', text: '保護眼鏡' },
      { style: 'ListParagraph', text: '電源を切る' },
      { style: 'ListParagraph', text: '表示灯を確認する' },
      { style: 'Heading2', text: '1.1 範囲' },
      { style: 'ListParagraph', text: '再開する' },
      ...['工程', '時間（分）', '組立', '30', '検査', '12.5', '備考'].map((text) => ({
        style: null,
        text,
      })),
    ]);
    const document = parts.get('word/document.xml') ?? '';
    expect(document).toContain('<w:br/>');
    expect(document.match(/<w:tblHeader\/>/gu)).toHaveLength(1);
    expect(document).toContain('<w:jc w:val="right"/>');
    // Bullets share instance 1; each numbered list is its own instance, restarting at 1.
    expect(
      [...document.matchAll(/<w:numId w:val="(\d+)"\/>/gu)].map((match) => match[1]),
    ).toStrictEqual(['1', '1', '2', '2', '3']);
    expect(parts.get('word/numbering.xml')?.match(/<w:startOverride w:val="1"\/>/gu)).toHaveLength(
      2,
    );
    expect(parts.get('word/styles.xml')).toContain('<w:outlineLvl w:val="5"/>');
  });

  it('writes a Word file without a title', () => {
    const file = buildOfficeFile({ format: 'docx', blocks: [{ type: 'paragraph', text: 'only' }] });
    expect(readDocx(file).paragraphs).toStrictEqual([{ style: null, text: 'only' }]);
  });

  it('writes a deck whose titles, bullets and table cells read back, slide by slide', () => {
    const parts = expectCompletePackage(buildOfficeFile(DECK));
    expect(slideTexts(parts)).toStrictEqual([
      ['提案の概要', '課題: 月次集計が手作業', '効果: 月20時間の削減', '（試算）'],
      ['費用', '初期費用なし', '項目', '金額（円）', '月額', '50000', '保守', '込み'],
      ['体制', 'PM', '山田（架空）'],
      ['ご清聴ありがとうございました'],
    ]);
    const second = parts.get('ppt/slides/slide2.xml') ?? '';
    expect(second).toContain('<p:ph type="title"/>');
    expect(second).toContain('<a:tblPr firstRow="1"/>');
    expect(second).toContain('<a:pPr algn="r"/>');
    expect(parts.get('ppt/slides/slide3.xml')).toContain('<a:tblPr firstRow="0"/>');
    expect(parts.get('ppt/slides/slide1.xml')).toContain('<a:br>');
    expect(parts.get('ppt/presentation.xml')).toContain('<p:sldId id="259" r:id="rId7"/>');
  });

  it('writes a workbook whose typed cells read back, with a frozen bold header and dates', () => {
    const file = buildOfficeFile(WORKBOOK);
    const parts = expectCompletePackage(file);
    const [sales, notes] = readXlsx(file).sheets;
    expect(sales?.name).toBe('売上');
    expect(sales?.rows).toStrictEqual([
      ['拠点', '売上（千円）', '達成', '締め日'],
      ['東京', 1200, true, 46_356],
      ['大阪', null, false, 61],
      ['名古屋 & <支店>', -3.25, null, null],
    ]);
    expect(notes?.rows).toStrictEqual([['repeated'], ['repeated']]);
    const first = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(first).toContain('state="frozen"');
    expect(first).toContain('<c r="A1" s="1" t="s">');
    expect(first).toContain('<c r="D2" s="2"><v>46356</v></c>');
    // Widths: a full-width header counts two per character; a date ten; a short value the minimum 8.
    expect(first).toContain('<col min="2" max="2" width="14" customWidth="1"/>');
    expect(first).toContain('<col min="4" max="4" width="12" customWidth="1"/>');
    expect(first).toContain('<col min="3" max="3" width="8" customWidth="1"/>');
    expect(parts.get('xl/worksheets/sheet2.xml')).not.toContain('frozen');
    // `count` is every string cell (9), `uniqueCount` the distinct strings (8).
    expect(parts.get('xl/sharedStrings.xml')).toContain('count="9" uniqueCount="8"');
  });

  it('keeps a CRLF, CR or LF line break as one break in Word and on a slide', () => {
    const text = 'one\r\ntwo\rthree\nfour';
    const docx = expectCompletePackage(
      buildOfficeFile({ format: 'docx', blocks: [{ type: 'paragraph', text }] }),
    );
    expect(docx.get('word/document.xml')?.match(/<w:br\/>/gu)).toHaveLength(3);
    const pptx = expectCompletePackage(
      buildOfficeFile({ format: 'pptx', slides: [{ title: 'T', bullets: [text] }] }),
    );
    expect(slideTexts(pptx)).toStrictEqual([['T', 'one', 'two', 'three', 'four']]);
    expect(pptx.get('ppt/slides/slide1.xml')?.match(/<a:br>/gu)).toHaveLength(3);
  });

  it('names columns past Z as Excel does', () => {
    const row = Array.from({ length: 28 }, (_, index) => index);
    const [sheet] = readXlsx(
      buildOfficeFile({ format: 'xlsx', sheets: [{ name: 'Wide', rows: [row] }] }),
    ).sheets;
    expect(sheet?.cells).toMatchObject({ Z1: 25, AA1: 26, AB1: 27 });
  });

  it('writes the same bytes for the same model', () => {
    expect(buildOfficeFile(DECK).equals(buildOfficeFile(DECK))).toBe(true);
  });
});

describe('office-writer command', () => {
  async function workspace(models: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-writer-'));
    for (const [name, model] of Object.entries(models))
      await writeFile(
        path.join(dir, name),
        typeof model === 'string' ? model : JSON.stringify(model),
      );
    return dir;
  }

  function capture(): {
    io: Parameters<typeof main>[1];
    stdout: () => string;
    stderr: () => unknown;
  } {
    let out = '';
    let err = '';
    return {
      io: {
        stdout: { write: (text: string) => (out += text) },
        stderr: { write: (text: string) => (err += text) },
      },
      stdout: () => out,
      stderr: () => (err.startsWith('{') ? (JSON.parse(err) as unknown) : err),
    };
  }

  it('runs as the command an agent calls: writes the file, creates its folder, prints where', async () => {
    const dir = await workspace({ 'deck.json': DECK });
    const { stdout } = await run(
      process.execPath,
      [SCRIPT, 'deck.json', 'outputs/提案/deck.pptx'],
      {
        cwd: dir,
      },
    );
    const file = await readFile(path.join(dir, 'outputs', '提案', 'deck.pptx'));
    expect(JSON.parse(stdout)).toStrictEqual({
      written: 'outputs/提案/deck.pptx',
      bytes: file.length,
    });
    await expect(
      run(process.execPath, [SCRIPT, 'deck.json', 'outputs/提案/deck.pptx'], { cwd: dir }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('"error":"output_exists"') as string,
    });
    await expect(run(process.execPath, [SCRIPT, 'deck.json'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
    });
  });

  it('writes in process and prints the result', async () => {
    const dir = await workspace({ 'book.json': WORKBOOK, 'doc.json': DOCUMENT });
    for (const [model, output] of [
      ['book.json', 'out/book.xlsx'],
      ['doc.json', 'out/doc.docx'],
    ] as const) {
      const { io, stdout } = capture();
      expect(main([path.join(dir, model), path.join(dir, output)], io)).toBe(0);
      expect(JSON.parse(stdout())).toMatchObject({ written: path.join(dir, output) });
    }
    expect(readXlsx(await readFile(path.join(dir, 'out/book.xlsx'))).sheets).toHaveLength(2);
  });

  it('refuses by name and writes nothing', async () => {
    const dir = await workspace({
      'deck.json': DECK,
      'broken.json': '{"format":',
      'invalid.json': { format: 'pptx', slides: [{ title: '' }] },
      'big.json': `{"format":"docx","blocks":[{"type":"paragraph","text":"${'x'.repeat(8 * 1024 * 1024)}"}]}`,
      'file.txt': 'a file, not a folder',
      'taken.pptx': 'an earlier file',
    });
    const at = (name: string) => path.join(dir, name);
    const cases: [string[], string][] = [
      [[at('deck.json'), at('deck.odp')], 'extension_mismatch'],
      [[at('deck.json'), at('deck.docx')], 'extension_mismatch'],
      [[at('missing.json'), at('x.pptx')], 'unreadable_model'],
      [[dir, at('x.pptx')], 'unreadable_model'],
      [[at('big.json'), at('x.docx')], 'model_too_large'],
      [[at('broken.json'), at('x.pptx')], 'invalid_json'],
      [[at('invalid.json'), at('x.pptx')], 'invalid_model'],
      [[at('deck.json'), at('taken.pptx')], 'output_exists'],
      [[at('deck.json'), at('file.txt/deck.pptx')], 'output_not_writable'],
      [[at('deck.json'), `${at('folder.pptx')}/`], 'output_not_writable'],
    ];
    for (const [args, code] of cases) {
      const { io, stderr } = capture();
      expect(main(args, io), code).toBe(1);
      expect(stderr(), code).toMatchObject({ error: code });
    }
    const { io, stderr } = capture();
    main([at('invalid.json'), at('x.pptx')], io);
    expect(stderr()).toStrictEqual({
      error: 'invalid_model',
      message: 'the model has 1 issue; the first is $.slides[0].title must not be empty',
      issues: [{ path: '$.slides[0].title', message: 'must not be empty' }],
    });
    await expect(readFile(at('x.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(at('taken.pptx'), 'utf8')).toBe('an earlier file');
  });

  it('removes the file it created when the write then fails, leaving nothing truncated', async () => {
    const dir = await workspace({});
    const output = path.join(dir, 'out', 'broken.docx');
    // Bytes the write cannot take: the file is created by the exclusive open, then the write throws.
    expect(() => {
      Reflect.apply(saveNewFile, undefined, [output, 42]);
    }).toThrow(expect.objectContaining({ code: 'output_not_writable' }) as Error);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    saveNewFile(output, Buffer.from('ok'));
    expect(await readFile(output, 'utf8')).toBe('ok');
  });

  it('answers a wrong number of arguments with its usage, and lets an unexpected error through', async () => {
    const usage = capture();
    expect(main([], usage.io)).toBe(2);
    expect(usage.stderr()).toMatch(/^usage: node write\.mjs/u);
    const dir = await workspace({ 'doc.json': DOCUMENT });
    const failing = {
      stdout: {
        write: () => {
          throw new Error('stdout closed');
        },
      },
      stderr: usage.io.stderr,
    };
    expect(() => main([path.join(dir, 'doc.json'), path.join(dir, 'doc.docx')], failing)).toThrow(
      'stdout closed',
    );
  });

  describe('as the entry point of its own process', () => {
    const argv = process.argv;

    afterEach(() => {
      process.argv = argv;
      process.exitCode = undefined;
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it('runs main with the process arguments and sets the exit code', async () => {
      const dir = await workspace({ 'doc.json': DOCUMENT });
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      process.argv = [
        process.execPath,
        SCRIPT,
        path.join(dir, 'doc.json'),
        path.join(dir, 'doc.docx'),
      ];
      vi.resetModules();
      await import('../office-writer/scripts/write.mjs');
      expect(process.exitCode).toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain('"written"');
    });
  });
});
