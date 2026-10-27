/**
 * The branch sales workbooks corporate planning receives every month, as they really arrive: five
 * branches, five layouts, none of them designed to be consolidated. The .xlsx files beside this
 * one are written from it with the office-reader skill's writer (`GALLERY_WRITE=1` regenerates
 * them), so the harness's `search_files` double reads them from `<project>/data` like uploaded files.
 *
 * | Branch | Sheet | Header | Date | Unit | Traps |
 * | --- | --- | --- | --- | --- | --- |
 * | 東京 | 売上明細 | rows 3–4, merged | 令和7年4月3日 | 千円 (in the header) | merged title, 小計 row, ※ note row |
 * | 大阪 | Sheet1 | row 1 | 2025/04/08 | 円 | 合計 row |
 * | 名古屋 | 名古屋営業所 | row 2 | Excel serial | 千円 | category before date, ※ remark in a notes column on a real sale |
 * | 福岡 | R7.4 / R7.5 | row 3 | 令和7年4月7日 | 円 (a 単位 row, not the header) | sheet renamed every month, （参考） row |
 * | 札幌 | 実績 (after a 表紙 sheet) | row 4 | R7.4.4 | 千円 (a 単位 row, not the header) | cover sheet, 合計 row |
 *
 * Plus a blank template and an expense workbook that a careless search would pick up.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  writeXlsx,
  type CellValue,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';

type Rows = (CellValue | null)[][];

interface Sheet {
  readonly name: string;
  readonly rows: Rows;
  readonly merges?: readonly string[];
}

export interface BranchFile {
  /** The workspace path (relative to `data/`), as `search_files` returns it. */
  readonly path: string;
  readonly modified: string;
  readonly sheets: readonly Sheet[];
}

/** Excel's 1900 date system: days since 1899-12-30. */
const serial = (iso: string): number =>
  (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

const tokyo = (month: number, lines: Rows, subtotal: number): Sheet => ({
  name: '売上明細',
  rows: [
    [`東京支店 売上報告 令和7年${String(month)}月`, null, null, null],
    [],
    ['日付', '区分', '売上', null],
    [null, null, '数量', '金額（千円）'],
    ...lines,
    ['小計', null, null, subtotal],
    ['※ 金額は税抜', null, null, null],
  ],
  merges: ['A1:D1', 'A3:A4', 'B3:B4', 'C3:D3'],
});

const osaka = (lines: Rows, total: number): Sheet => ({
  name: 'Sheet1',
  rows: [['計上日', '商品区分', '金額(円)'], ...lines, ['合計', null, total]],
});

const nagoya = (month: number, lines: Rows): Sheet => ({
  name: '名古屋営業所',
  rows: [
    [`名古屋営業所\u3000月次売上（令和7年${String(month)}月）`, null, null, null],
    ['区分', '日付', '売上高（千円）', '備考'],
    ...lines,
  ],
  merges: ['A1:D1'],
});

const fukuoka = (month: number, lines: Rows, notes: Rows): Sheet => ({
  name: `R7.${String(month)}`,
  rows: [['福岡支店 売上報告'], ['単位：円'], ['日付', '区分', '金額'], ...lines, ...notes],
});

const sapporo = (month: number, lines: Rows, total: number): Sheet[] => [
  { name: '表紙', rows: [['札幌営業所 月次報告'], ['作成者', '佐藤']] },
  {
    name: '実績',
    rows: [
      [`令和7年${String(month)}月 実績`],
      ['単位：千円'],
      [],
      ['日付', '区分', '売上高'],
      ...lines,
      ['合計', null, total],
    ],
  },
];

const APRIL = '2025-05-07T09:00:00Z';
const MAY = '2025-06-06T09:00:00Z';

export const BRANCH_FILES: readonly BranchFile[] = [
  {
    path: '東京支店/東京_売上報告_2025年4月.xlsx',
    modified: APRIL,
    sheets: [
      tokyo(
        4,
        [
          ['令和7年4月3日', '機器', 3, 1200],
          ['令和7年4月15日', '保守', 1, 300],
          ['令和7年4月25日', '機器', 2, 800],
        ],
        2300,
      ),
    ],
  },
  {
    path: '東京支店/東京_売上報告_2025年5月.xlsx',
    modified: MAY,
    sheets: [
      tokyo(
        5,
        [
          ['令和7年5月8日', '機器', 4, 1500],
          ['令和7年5月19日', '保守', 1, 320],
          ['令和7年5月28日', '機器', 2, 980],
        ],
        2800,
      ),
    ],
  },
  {
    path: '大阪支店/大阪 月次売上 202504.xlsx',
    modified: APRIL,
    sheets: [
      osaka(
        [
          ['2025/04/08', '機器', 1_850_000],
          ['2025/04/22', '保守', 410_000],
        ],
        2_260_000,
      ),
    ],
  },
  {
    path: '大阪支店/大阪 月次売上 202505.xlsx',
    modified: MAY,
    sheets: [
      osaka(
        [
          ['2025/05/09', '機器', 1_620_000],
          ['2025/05/23', '保守', 395_000],
        ],
        2_015_000,
      ),
    ],
  },
  {
    path: '名古屋営業所/名古屋_売上_R7.4.xlsx',
    modified: APRIL,
    sheets: [
      nagoya(4, [
        ['機器', serial('2025-04-10'), 950, null],
        ['保守', serial('2025-04-25'), 210.5, '※値引後'],
      ]),
    ],
  },
  {
    path: '名古屋営業所/名古屋_売上_R7.5.xlsx',
    modified: MAY,
    sheets: [
      nagoya(5, [
        ['機器', serial('2025-05-12'), 1100, null],
        ['保守', serial('2025-05-27'), 230, null],
      ]),
    ],
  },
  {
    path: '福岡支店/福岡支店売上報告（令和7年4月）.xlsx',
    modified: APRIL,
    sheets: [
      fukuoka(
        4,
        [
          ['令和7年4月7日', '機器', 720_000],
          ['令和7年4月18日', '保守', 180_000],
        ],
        [['※ 3月分の訂正はありません', null, null]],
      ),
    ],
  },
  {
    path: '福岡支店/福岡支店売上報告（令和7年5月）.xlsx',
    modified: MAY,
    sheets: [
      fukuoka(
        5,
        [
          ['令和7年5月14日', '機器', 860_000],
          ['令和7年5月26日', '保守', 175_000],
        ],
        [['（参考）前年同月', null, 990_000]],
      ),
    ],
  },
  {
    path: '札幌営業所/札幌_月次報告_2025-04.xlsx',
    modified: APRIL,
    sheets: sapporo(
      4,
      [
        ['R7.4.4', '機器', 640],
        ['R7.4.21', '保守', 150],
      ],
      790,
    ),
  },
  {
    path: '札幌営業所/札幌_月次報告_2025-05.xlsx',
    modified: MAY,
    sheets: sapporo(
      5,
      [
        ['R7.5.2', '機器', 580],
        ['R7.5.19', '保守', 160],
      ],
      740,
    ),
  },
  {
    path: '共通/売上報告テンプレート.xlsx',
    modified: '2024-03-01T09:00:00Z',
    sheets: [{ name: '売上', rows: [['日付', '区分', '金額（円）']] }],
  },
  {
    path: '東京支店/東京_経費精算_2025年5月.xlsx',
    modified: MAY,
    sheets: [
      {
        name: '経費',
        rows: [
          ['日付', '費目', '金額'],
          ['令和7年5月9日', '交通費', 12_340],
        ],
      },
    ],
  },
];

/** Write every workbook under `root`, with its modified time, plus a non-Excel file. */
export function writeBranchWorkbooks(root: string): void {
  for (const file of BRANCH_FILES) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, writeXlsx({ sheets: file.sheets }));
    const time = new Date(file.modified);
    utimesSync(target, time, time);
  }
  writeFileSync(
    path.join(root, '東京支店', '売上報告の書き方.txt'),
    '金額は千円単位で記入する。\n',
  );
}
