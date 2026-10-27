/**
 * The press-process FMEA as a quality department keeps it: an Excel sheet, one row per failure
 * cause, with the review notes on a second sheet. `fmea/press-pfmea.xlsx` is written from it with the office-reader skill's writer (`GALLERY_WRITE=1` regenerates it).
 */
import { writeFileSync } from 'node:fs';

import {
  writeXlsx,
  type CellValue,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';

type Row = (CellValue | null)[];

interface Sheet {
  readonly name: string;
  readonly rows: readonly Row[];
}

const HEADER: Row = [
  'No.',
  '工程機能',
  '故障モード',
  '影響',
  'S',
  '故障原因',
  'O',
  '現行の予防管理',
  '現行の検出管理',
  'D',
  'RPN',
  '関連過去トラ',
];

export const PFMEA_ROWS: readonly Row[] = [
  [
    'P-03-01',
    '外形抜き',
    'バリ高さ超過（規格0.1mm以下）',
    '組付け時の手切れ、相手部品のキズ',
    6,
    'パンチ刃先摩耗によるクリアランス拡大',
    4,
    '7.5万ショットで研磨（自動保全指示）',
    '初品・終品のバリ高さ測定',
    5,
    120,
    'Q-1003, Q-1011, Q-1042',
  ],
  [
    'P-03-02',
    '外形抜き',
    'バリ高さ超過',
    '同上',
    6,
    '板厚公差上限材によるクリアランス不足',
    2,
    '受入時板厚3点測定',
    '初品のバリ高さ測定',
    5,
    60,
    'Q-1019',
  ],
  [
    'P-03-03',
    '外形抜き',
    'バリ高さ超過',
    '同上',
    6,
    '初品検査の未実施（未教育者）',
    2,
    'スキルマップによる作業者認定',
    '初品記録なしで量産開始不可',
    3,
    36,
    'Q-1061',
  ],
  [
    'P-03-04',
    '穴抜き',
    '穴位置ずれ',
    '組付け不可',
    7,
    'パイロットピン摩耗',
    3,
    '月次の金型点検（ピン外径）',
    '全数ゲージ検査',
    2,
    42,
    'Q-1055',
  ],
  [
    'P-03-05',
    '曲げ',
    '曲げ角度不良',
    '組付け不可',
    7,
    'スプリングバック補正不足',
    3,
    '材料変更時の型補正確認',
    '初品の角度測定',
    4,
    84,
    'Q-1036',
  ],
];

export const PFMEA_SHEETS: readonly Sheet[] = [
  {
    name: 'PFMEA-P-03',
    rows: [
      ['工程FMEA（プレス工程）抜粋'],
      ['文書番号', 'PFMEA-P-03', '改訂日', '2025-04-01'],
      ['対象', 'BRK-2201 フロントブラケット、BRK-2205 リアブラケット（順送型・抜き曲げ）'],
      [],
      HEADER,
      ...PFMEA_ROWS,
    ],
  },
  {
    name: '見直しメモ',
    rows: [
      ['見直しメモ'],
      [
        'P-03-01 は再発が続いている（Q-1003 → Q-1011 → Q-1042）。ショット数の自動集計後も、保全指示の延期で発生した。検出管理が初品・終品のみのため、量産途中の摩耗進行を検出できない。検出度 D=5 の見直しが課題。',
      ],
      ['新規不具合でバリが出た場合は、P-03-01〜03 のどの故障原因に当たるかを先に切り分ける。'],
    ],
  },
];

/** Write `press-pfmea.xlsx` to `file`. */
export function writePfmea(file: string): void {
  writeFileSync(file, writeXlsx({ sheets: PFMEA_SHEETS }));
}
