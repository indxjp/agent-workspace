import {
  OOXML_LIMITS,
  readXlsx,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { type MappingPlan } from './backend/consolidate.ts';
import { BRANCH_FILES } from './data/branch-workbooks.ts';
import {
  CONSOLIDATE,
  consolidate,
  DATA,
  node,
  PLAN,
  work,
} from './excel-consolidation.fixture.test-support.ts';
import {
  detectUnit,
  serialToIso,
  warekiToIso,
  ymdToIso,
} from './skills/excel-consolidate/scripts/consolidate.mjs';
import {
  OOXML_LIMITS as COPIED_LIMITS,
  readXlsx as readXlsxCopy,
} from './skills/excel-consolidate/scripts/xlsx.mjs';

export function describeExcelConversion(): void {
  it("the skill's copy of the reader gives the built-in office-reader's results on every shipped workbook", () => {
    expect(COPIED_LIMITS).toStrictEqual(OOXML_LIMITS);
    for (const file of BRANCH_FILES) {
      const bytes = readFileSync(path.join(DATA, file.path));
      expect(readXlsxCopy(bytes), file.path).toStrictEqual(readXlsx(bytes));
    }
    const refusal = (read: (bytes: Buffer) => unknown): string => {
      try {
        read(Buffer.from('not a zip'));
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
      return '';
    };
    expect(refusal(readXlsx)).not.toBe('');
    expect(refusal(readXlsxCopy)).toBe(refusal(readXlsx));
  });

  it('the script converts 和暦, Excel serials and slashed dates by rule', () => {
    expect(warekiToIso('令和7年5月12日')).toBe('2025-05-12');
    expect(warekiToIso('令和元年5月1日')).toBe('2019-05-01');
    expect(warekiToIso('平成31年4月30日')).toBe('2019-04-30');
    expect(warekiToIso('Ｒ７.５.２')).toBe('2025-05-02');
    expect(warekiToIso('H8/2/29')).toBe('1996-02-29');
    expect(() => warekiToIso('平成31年5月1日')).toThrow(/outside the 平成 era/u);
    expect(() => warekiToIso('令和7年2月30日')).toThrow(/not a calendar date/u);
    expect(() => warekiToIso('2025/05/12')).toThrow(/not a 和暦 date/u);
    expect(serialToIso(45778)).toBe('2025-05-01');
    expect(ymdToIso('2025/5/9')).toBe('2025-05-09');
  });

  it('the script consolidates five layouts with exact totals and a source cell for every value', async () => {
    const report = await consolidate(PLAN);
    // `--out` saves what the next call reads, and stdout carries the same report.
    expect(
      JSON.parse(readFileSync(path.join(work, 'outputs', 'report.json'), 'utf8')),
    ).toStrictEqual(report);

    expect(report.totals).toStrictEqual({
      '2025-04': {
        東京: 2_300_000,
        大阪: 2_260_000,
        名古屋: 1_160_500,
        福岡: 900_000,
        札幌: 790_000,
      },
      '2025-05': {
        東京: 2_800_000,
        大阪: 2_015_000,
        名古屋: 1_330_000,
        福岡: 1_035_000,
        札幌: 740_000,
      },
    });
    expect(report.comparison.total).toStrictEqual({
      previous: 7_410_500,
      current: 7_920_000,
      diff: 509_500,
      pct: 6.9,
    });
    expect(report.comparison.branches).toStrictEqual([
      { branch: '東京', previous: 2_300_000, current: 2_800_000, diff: 500_000, pct: 21.7 },
      { branch: '大阪', previous: 2_260_000, current: 2_015_000, diff: -245_000, pct: -10.8 },
      { branch: '名古屋', previous: 1_160_500, current: 1_330_000, diff: 169_500, pct: 14.6 },
      { branch: '福岡', previous: 900_000, current: 1_035_000, diff: 135_000, pct: 15 },
      { branch: '札幌', previous: 790_000, current: 740_000, diff: -50_000, pct: -6.3 },
    ]);

    expect(report.rows).toHaveLength(22);
    expect(
      report.rows.find((row) => row.branch === '東京' && row.date === '2025-05-08'),
    ).toStrictEqual({
      branch: '東京',
      date: '2025-05-08',
      month: '2025-05',
      category: '機器',
      amount: 1_500_000,
      raw: { amount: 1500, unit: '千円' },
      '@src': {
        date: '東京支店/東京_売上報告_2025年5月.xlsx!売上明細!A5',
        category: '東京支店/東京_売上報告_2025年5月.xlsx!売上明細!B5',
        amount: '東京支店/東京_売上報告_2025年5月.xlsx!売上明細!D5',
      },
    });
    // A ※ remark in 名古屋's notes column is a real sale, not a note row.
    expect(
      report.rows.find((row) => row.branch === '名古屋' && row.date === '2025-04-25'),
    ).toMatchObject({
      amount: 210_500,
      '@src': { amount: '名古屋営業所/名古屋_売上_R7.4.xlsx!名古屋営業所!C4' },
    });
    expect(report.rows.filter((row) => row.branch === '札幌').map((row) => row.date)).toStrictEqual(
      ['2025-04-04', '2025-04-21', '2025-05-02', '2025-05-19'],
    );
    expect(report.skipped.map((entry) => entry.text)).toStrictEqual([
      '小計',
      '※ 金額は税抜',
      '小計',
      '※ 金額は税抜',
      '合計',
      '合計',
      '※ 3月分の訂正はありません',
      '(参考)前年同月',
      '合計',
      '合計',
    ]);
  });

  it('the script stops when a header contradicts the plan unit', async () => {
    const wrong: MappingPlan = {
      ...PLAN,
      layouts: PLAN.layouts.map((layout) =>
        layout.branch === '東京' ? { ...layout, unit: '円' } : layout,
      ),
    };
    const failure = (await consolidate(wrong).catch((error: unknown) => error)) as {
      code?: number;
      stderr?: string;
    };
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(
      '売上明細!D4 says 千円 (売上 / 金額（千円）) but the plan says 円',
    );
  });

  it("inspect names each sheet's unit, so turn 1 states it without reading every sheet by eye", async () => {
    const files = BRANCH_FILES.map((file) => file.path);
    const inspected = JSON.parse(await node(CONSOLIDATE, ['inspect', ...files])) as {
      file: string;
      sheets: { sheet: string; unit: string | null; unitFrom: string | null }[];
    }[];
    expect(inspected.map((entry) => entry.file)).toStrictEqual(
      files.map((file) => path.basename(file)),
    );
    for (const layout of PLAN.layouts) {
      for (const file of layout.files) {
        const entry = inspected.find((item) => item.file === path.basename(file));
        const sheet = entry?.sheets.find((item) => item.sheet === layout.sheet);
        expect(sheet?.unit, `${file} ${layout.sheet}`).toBe(layout.unit);
        expect(sheet?.unitFrom, file).not.toBeNull();
      }
    }
    // 福岡 and 札幌 state it in a 単位 row, 東京 in the header; 札幌's cover sheet states nothing.
    const sheetOf = (file: string, sheet: string) =>
      inspected
        .find((item) => item.file === path.basename(file))
        ?.sheets.find((item) => item.sheet === sheet);
    expect(sheetOf('福岡支店/福岡支店売上報告（令和7年5月）.xlsx', 'R7.5')?.unitFrom).toBe(
      'A2 単位:円',
    );
    expect(sheetOf('東京支店/東京_売上報告_2025年5月.xlsx', '売上明細')?.unitFrom).toBe(
      'D4 金額(千円)',
    );
    expect(sheetOf('札幌営業所/札幌_月次報告_2025-05.xlsx', '表紙')?.unit).toBeNull();
    expect(detectUnit({ name: 'x', merges: [], rows: [['金額(円)', '単位：千円']] })?.unit).toBe(
      '千円',
    );
    expect(detectUnit({ name: 'x', merges: [], rows: [['日付', '区分', '金額']] })).toBeNull();
  });
}
