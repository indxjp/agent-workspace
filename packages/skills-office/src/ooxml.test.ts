/**
 * The office-reader skill's Excel and Word script, run as an agent runs it: `node scripts/ooxml.mjs`
 * on a file, reading JSON from stdout. The fixtures are written by the same module, so the reader is
 * also checked against a zip the platform's own Python could open (stored CRCs, deflate).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  OOXML_LIMITS,
  OoxmlRefusal,
  readDocx,
  readXlsx,
  readZip,
  writeDocx,
  writeXlsx,
} from '../office-reader/scripts/ooxml.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'office-reader',
  'scripts',
  'ooxml.mjs',
);
const run = promisify(execFile);

/** A zip of already-deflated entries; the reader does not check CRCs, so a bomb costs a few KiB. */
function zipOf(entries: readonly { name: string; deflated: Buffer; size: number }[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, deflated, size } of entries) {
    const label = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(label.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(label.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, label, deflated);
    centrals.push(central, label);
    offset += local.length + label.length + deflated.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const zeros = (size: number) => ({ deflated: deflateRawSync(Buffer.alloc(size)), size });

function refusalOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof OoxmlRefusal ? error.code : String(error);
  }
  return undefined;
}

describe('office-reader', () => {
  it('reads a workbook with merged headers as the screen shows it, keeping the cell addresses', () => {
    const workbook = writeXlsx({
      sheets: [
        {
          name: '大阪支店',
          rows: [
            ['2025年度 売上実績', null, null],
            ['拠点', '売上高（千円）', null],
            ['大阪', 1200, '令和7年4月'],
          ],
          merges: ['A1:C1', 'B2:C2'],
        },
      ],
    });
    const [sheet] = readXlsx(workbook).sheets;
    expect(sheet?.name).toBe('大阪支店');
    expect(sheet?.rows[0]).toStrictEqual([
      '2025年度 売上実績',
      '2025年度 売上実績',
      '2025年度 売上実績',
    ]);
    expect(sheet?.rows[1]).toStrictEqual(['拠点', '売上高（千円）', '売上高（千円）']);
    expect(sheet?.cells).toMatchObject({ B3: 1200, C3: '令和7年4月' });
    expect(sheet?.merges).toStrictEqual(['A1:C1', 'B2:C2']);
  });

  it('reads Word paragraphs with their styles and escaped text', () => {
    const document = writeDocx({
      paragraphs: [
        { style: 'Heading1', text: '第8条（損害賠償）' },
        { text: '甲は乙に対し、<上限> & 条件を定める。' },
      ],
    });
    expect(readDocx(document).paragraphs).toStrictEqual([
      { style: 'Heading1', text: '第8条（損害賠償）' },
      { style: null, text: '甲は乙に対し、<上限> & 条件を定める。' },
    ]);
  });

  it('refuses a file that is not a zip', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/not a zip/u);
  });

  it('writes a workbook or a Word file from a JSON spec, which reads back as written', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-reader-'));
    const sheets = {
      sheets: [
        {
          name: '前月比',
          rows: [
            ['拠点', '差額'],
            ['東京', 500_000],
          ],
        },
      ],
    };
    const paragraphs = { paragraphs: [{ style: 'Heading1', text: '第1条（目的）' }] };
    await writeFile(path.join(dir, 'sheets.json'), JSON.stringify(sheets));
    await writeFile(path.join(dir, 'paragraphs.json'), JSON.stringify(paragraphs));

    await run(process.execPath, [
      SCRIPT,
      'write',
      path.join(dir, 'sheets.json'),
      path.join(dir, 'out.xlsx'),
    ]);
    await run(process.execPath, [
      SCRIPT,
      'write',
      path.join(dir, 'paragraphs.json'),
      path.join(dir, 'out.docx'),
    ]);
    const { stdout } = await run(process.execPath, [SCRIPT, 'xlsx', path.join(dir, 'out.xlsx')]);
    expect(
      (JSON.parse(stdout) as { sheets: { rows: unknown[][] }[] }).sheets[0]?.rows,
    ).toStrictEqual(sheets.sheets[0]?.rows);
    expect(readDocx(await readFile(path.join(dir, 'out.docx'))).paragraphs).toStrictEqual([
      { style: 'Heading1', text: '第1条（目的）' },
    ]);
    await expect(
      run(process.execPath, [SCRIPT, 'write', path.join(dir, 'sheets.json')]),
    ).rejects.toMatchObject({
      code: 2,
    });
  });

  it('runs as the command an agent calls, printing JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-reader-'));
    const file = path.join(dir, 'book.xlsx');
    await writeFile(
      file,
      writeXlsx({
        sheets: [
          {
            name: 'Sheet1',
            rows: [
              ['品目', '数量'],
              ['ボルト', 40],
            ],
          },
        ],
      }),
    );
    const { stdout } = await run(process.execPath, [SCRIPT, 'xlsx', file]);
    const parsed = JSON.parse(stdout) as { sheets: { rows: unknown[][] }[] };
    expect(parsed.sheets[0]?.rows).toStrictEqual([
      ['品目', '数量'],
      ['ボルト', 40],
    ]);
    await expect(run(process.execPath, [SCRIPT, 'odt', file])).rejects.toMatchObject({ code: 2 });
  });

  it('docx with an output path writes the same JSON there and prints only where', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-reader-'));
    const file = path.join(dir, 'contract.docx');
    await writeFile(
      file,
      writeDocx({ paragraphs: [{ style: 'Heading1', text: '第1条（目的）' }] }),
    );
    const printed = await run(process.execPath, [SCRIPT, 'docx', file]);
    const out = path.join('drafts', 'contract.json');
    const written = await run(process.execPath, [SCRIPT, 'docx', file, out], { cwd: dir });
    expect(JSON.parse(written.stdout)).toStrictEqual({ written: out });
    expect(await readFile(path.join(dir, out), 'utf8')).toBe(printed.stdout);
  });

  describe('limits on an untrusted file', () => {
    it('refuses an entry that inflates past the entry cap, without inflating it', () => {
      const bomb = zipOf([{ name: 'word/document.xml', ...zeros(OOXML_LIMITS.entryBytes + 1) }]);
      expect(bomb.length).toBeLessThan(1024 * 1024);
      expect(refusalOf(() => readDocx(bomb))).toBe('entry_too_large');
    });

    it('refuses an archive whose entries add up past the total cap', () => {
      const part = zeros(OOXML_LIMITS.entryBytes - 4 * 1024 * 1024);
      const bomb = zipOf([
        { name: 'a.xml', ...part },
        { name: 'b.xml', ...part },
        { name: 'c.xml', ...part },
      ]);
      expect(refusalOf(() => readXlsx(bomb))).toBe('archive_too_large');
    });

    it('refuses an archive that lists more entries than the entry-count cap', () => {
      const empty = zeros(0);
      const bomb = zipOf(
        Array.from({ length: OOXML_LIMITS.entries + 1 }, (_, index) => ({
          name: `p${index}.xml`,
          ...empty,
        })),
      );
      expect(refusalOf(() => readZip(bomb))).toBe('too_many_entries');
    });

    it('accepts an archive at the entry-count cap', () => {
      const empty = zeros(0);
      const zip = zipOf(
        Array.from({ length: OOXML_LIMITS.entries }, (_, index) => ({
          name: `p${index}.xml`,
          ...empty,
        })),
      );
      expect(readZip(zip).size).toBe(OOXML_LIMITS.entries);
    });

    it('refuses a corrupt archive by name instead of throwing a RangeError', () => {
      const good = writeXlsx({ sheets: [{ name: 'S', rows: [['a']] }] });
      const end = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      const pointsPastEnd = Buffer.from(good);
      pointsPastEnd.writeUInt32LE(good.length + 100, end + 16);
      const truncated = good.subarray(0, end + 10);
      expect(refusalOf(() => readXlsx(pointsPastEnd))).toBe('corrupt_archive');
      expect(refusalOf(() => readDocx(truncated))).toBe('corrupt_archive');
      expect(refusalOf(() => readZip(Buffer.from('not a zip at all, but long enough')))).toBe(
        'corrupt_archive',
      );
    });

    it('refuses a file past the file-size cap, in memory and before the command reads it', async () => {
      expect(refusalOf(() => readZip(Buffer.alloc(OOXML_LIMITS.fileBytes + 1)))).toBe(
        'archive_too_large',
      );
      const dir = await mkdtemp(path.join(tmpdir(), 'office-reader-big-'));
      const file = path.join(dir, 'big.docx');
      await writeFile(file, '');
      await truncate(file, OOXML_LIMITS.fileBytes + 1);
      await expect(run(process.execPath, [SCRIPT, 'docx', file])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('"error":"archive_too_large"') as string,
      });
    });
  });
});
