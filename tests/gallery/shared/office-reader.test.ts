/**
 * The shared office-reader skill's script, run as an agent runs it: `node scripts/ooxml.mjs` on a
 * file, reading JSON from stdout. The fixtures are written by the same module, so the reader is
 * also checked against a zip the platform's own Python could open (stored CRCs, deflate).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  readDocx,
  readXlsx,
  readZip,
  writeDocx,
  writeXlsx,
} from './skills/office-reader/scripts/ooxml.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skills',
  'office-reader',
  'scripts',
  'ooxml.mjs',
);
const run = promisify(execFile);

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
    await expect(run(process.execPath, [SCRIPT, 'pdf', file])).rejects.toMatchObject({ code: 2 });
  });
});
