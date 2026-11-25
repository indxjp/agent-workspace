/**
 * The inspection entry's recorder: the inspection record the prompt names, read with the six items
 * of the BK-210 standard, one verdict per item, and the report written behind the approval. Lot
 * 2611-07 has sample 2 of INS-02 at 45.12 mm (above 45.10) and sample 2 of INS-05 marked ×, so both
 * are NG; INS-03 has a blank sample and the INS-04 row no checker, so both are caution.
 */
import inspectionAgent from '../../../../use-cases/inspection/agents/inspection.ts';
import type { Recorder } from '../types.ts';
import { carries, reporting, table, type Bilingual } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const RECORD = '検査記録_BK-210_ロット2611-07';
const STANDARDS = [
  'INS-01-outer-diameter',
  'INS-02-hole-pitch',
  'INS-03-thickness',
  'INS-04-hardness',
  'INS-05-appearance',
  'INS-06-record',
].map((name) => `inspection/standards/${name}.md`);

const NG_ACTION = {
  ja: 'ロットを出荷保留にし、品質保証課が処置（全数選別・手直し・廃却）を判断する',
  en: 'Hold the lot; quality assurance decides what to do (100% sorting, rework or scrapping)',
};

const TABLE: Bilingual = {
  ja: table(
    ['項目', '記録', '判定', '理由', '処置'],
    [
      [
        '外径',
        '20.01, 19.98, 20.03 mm',
        'OK',
        '全サンプルが 19.95〜20.05 mm の範囲内〔INS-01〕',
        '',
      ],
      [
        '穴ピッチ',
        '45.04, 45.12, 44.97 mm',
        'NG',
        'サンプル2の 45.12 mm が上限 45.10 mm を超えている〔INS-02〕',
        NG_ACTION.ja,
      ],
      [
        '板厚',
        '3.21, 空欄, 3.18 mm',
        '要注意',
        'サンプル2が空欄（ほかの値は 3.10〜3.30 mm の範囲内）〔INS-03〕',
        '空欄のサンプルを再測定して記入する',
      ],
      ['硬さ', '32, 35, 33 HRC', 'OK', '全サンプルが 30〜36 HRC の範囲内〔INS-04〕', ''],
      [
        '外観',
        '○, ×, ○',
        'NG',
        'サンプル2の判定欄が「×」〔INS-05〕',
        '不良のサンプルを隔離し、品質保証課が処置を判断する',
      ],
      [
        '記録の記入',
        '全行',
        '要注意',
        'INS-04（硬さ）の行の確認者が空欄〔INS-06〕',
        '空欄の欄を、検査者又は確認者が記入する',
      ],
    ],
  ),
  en: table(
    ['Item', 'Recorded', 'Verdict', 'Why', 'Action'],
    [
      [
        'Outer diameter',
        '20.01, 19.98, 20.03 mm',
        'OK',
        'Every sample is within 19.95 to 20.05 mm [INS-01]',
        '',
      ],
      [
        'Hole pitch',
        '45.04, 45.12, 44.97 mm',
        'NG',
        'Sample 2, 45.12 mm, is above the upper limit of 45.10 mm [INS-02]',
        NG_ACTION.en,
      ],
      [
        'Thickness',
        '3.21, blank, 3.18 mm',
        'caution',
        'Sample 2 is blank (the other values are within 3.10 to 3.30 mm) [INS-03]',
        'Measure the blank sample again and fill it in',
      ],
      ['Hardness', '32, 35, 33 HRC', 'OK', 'Every sample is within 30 to 36 HRC [INS-04]', ''],
      [
        'Appearance',
        '○, ×, ○',
        'NG',
        'Sample 2 is marked "×" [INS-05]',
        'Isolate the defective sample; quality assurance decides what to do',
      ],
      [
        'Record completeness',
        'every row',
        'caution',
        'The checker is blank on the INS-04 (hardness) row [INS-06]',
        'The inspector or the checker fills in the blank field',
      ],
    ],
  ),
};

const ANSWER: Bilingual = {
  ja: `ロット2611-07（品番 BK-210）の検査記録を、検査基準書の INS-01〜INS-06 と照合しました。NGが2件（INS-02 穴ピッチ、INS-05 外観）、要注意が2件（INS-03 板厚、INS-06 記録の記入）、OKが2件です。承認されたレポートを inspection-reports/${RECORD}_review.md に保存しました。\n\n${TABLE.ja}\n\nロットの処置は品質保証の担当者が判断してください。`,
  en: `I checked the record of lot 2611-07 (part BK-210) against INS-01 to INS-06 of the inspection standard: 2 NG (INS-02, hole pitch; INS-05, appearance), 2 caution (INS-03, thickness; INS-06, record completeness) and 2 OK. The approved report is saved to inspection-reports/${RECORD}_review.md.\n\n${TABLE.en}\n\nA person in quality assurance decides what happens to the lot.`,
};

export const inspection: Recorder = (ask) => {
  carries(ask, `inspection/inbox/${RECORD}.csv`);
  return playUseCase(
    ask.slug,
    inspectionAgent,
    reporting({
      queries: [],
      open: [`inspection/inbox/${RECORD}.csv`, ...STANDARDS],
      file: `inspection-reports/${RECORD}_review.md`,
      report: `# ${RECORD} ${ask.lang === 'ja' ? 'チェック' : 'check'}\n\n${TABLE[ask.lang]}\n`,
      answer: ANSWER[ask.lang],
    }),
    ask,
  );
};
