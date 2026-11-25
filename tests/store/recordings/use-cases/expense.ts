/**
 * The expense entry's recorder: the expense claim the prompt names, read with the six items of the
 * travel and expense policy, one verdict per claim line, and the report written behind the
 * approval. Every amount in the table is the claim's own, compared as written.
 */
import expenseAgent from '../../../../use-cases/expense/agents/expense.ts';
import type { Recorder } from '../types.ts';
import { carries, reporting, table, type Bilingual } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const CLAIM = '経費精算_EX-2611-0042_渡瀬ハルキ';
const STANDARDS = [
  'EXP-01-lodging',
  'EXP-02-transport',
  'EXP-03-taxi',
  'EXP-04-meals',
  'EXP-05-receipts',
  'EXP-06-personal',
].map((name) => `expense/standards/${name}.md`);

const TABLE: Bilingual = {
  ja: table(
    ['明細', '申請内容', '判定', '理由', '修正案', '規程'],
    [
      [
        '1',
        '交通費 新幹線 東京→名古屋 普通車指定席 11,300円',
        'OK',
        '普通車指定席で、領収書の金額と一致',
        '',
        '〔EXP-02〕',
      ],
      [
        '2',
        '宿泊費 名古屋 ビジネスホテル 1泊 14,800円',
        'NG',
        '1泊 12,000円の上限を超え、事前承認番号がない',
        '上限を超える額を自己負担とするか、事前承認番号を付けて申請し直す',
        '〔EXP-01〕',
      ],
      [
        '3',
        '交通費 タクシー 名古屋駅→株式会社ミソサザイ工機 2,860円',
        '要注意',
        '備考に利用の理由（時刻又は区間）がない',
        '備考に利用の時刻又は公共交通機関がない理由を書き足す',
        '〔EXP-03〕',
      ],
      [
        '4',
        '会議費 取引先との昼食 6,600円',
        '要注意',
        '参加者の記入がない',
        '参加者の氏名と会社名を記入する',
        '〔EXP-04〕',
      ],
      [
        '5',
        '交通費 新幹線 名古屋→東京 グリーン車 16,560円',
        'NG',
        'グリーン車で、事前承認番号がない',
        '普通車指定席の運賃で申請し直すか、事前承認番号を付ける',
        '〔EXP-02〕',
      ],
      [
        '6',
        '消耗品費 文具（ボールペン） 1,980円',
        'NG',
        '申請金額 1,980円が領収書の金額 1,780円と一致しない',
        '申請金額を領収書の金額に合わせて申請し直す',
        '〔EXP-05〕',
      ],
      [
        '7',
        '雑費 土産（家族用） 3,240円',
        'NG',
        '家族のための費用は精算の対象外',
        '明細を申請から削除する',
        '〔EXP-06〕',
      ],
    ],
  ),
  en: table(
    ['Line', 'Claimed', 'Verdict', 'Why', 'Suggested fix', 'Item'],
    [
      [
        '1',
        'Transport, shinkansen Tokyo to Nagoya, reserved standard seat, JPY 11,300',
        'OK',
        'A standard reserved seat, and the amount matches the receipt',
        '',
        '[EXP-02]',
      ],
      [
        '2',
        'Lodging, business hotel in Nagoya, 1 night, JPY 14,800',
        'NG',
        'Above the limit of JPY 12,000 a night, with no prior approval number',
        'Pay the amount above the limit yourself, or claim again with a prior approval number',
        '[EXP-01]',
      ],
      [
        '3',
        'Transport, taxi from Nagoya Station to 株式会社ミソサザイ工機, JPY 2,860',
        'caution',
        'The remarks give no reason (the time or the route)',
        'Add the time, or why there was no public transport, to the remarks',
        '[EXP-03]',
      ],
      [
        '4',
        'Meeting, lunch with a client, JPY 6,600',
        'caution',
        'No attendees are written',
        'Write the names and companies of the attendees',
        '[EXP-04]',
      ],
      [
        '5',
        'Transport, shinkansen Nagoya to Tokyo, Green Car, JPY 16,560',
        'NG',
        'A Green Car seat with no prior approval number',
        'Claim the standard reserved-seat fare, or add a prior approval number',
        '[EXP-02]',
      ],
      [
        '6',
        'Supplies, stationery (ballpoint pens), JPY 1,980',
        'NG',
        'The amount claimed, JPY 1,980, does not match the receipt, JPY 1,780',
        'Claim again with the receipt amount',
        '[EXP-05]',
      ],
      [
        '7',
        'Miscellaneous, souvenirs (for family), JPY 3,240',
        'NG',
        'Costs for family are not reimbursed',
        'Remove the line from the claim',
        '[EXP-06]',
      ],
    ],
  ),
};

const ANSWER: Bilingual = {
  ja: `申請 EX-2611-0042（渡瀬 ハルキ）の7明細を、旅費・経費規程の EXP-01〜EXP-06 と照らしました。NGが4件（明細2・5・6・7）、要注意が2件（明細3・4）、OKが1件（明細1）です。承認されたレポートを expense-reports/${CLAIM}_review.md に保存しました。\n\n${TABLE.ja}\n\n精算するかどうかは承認者が判断してください。`,
  en: `I checked the 7 lines of claim EX-2611-0042 (渡瀬 ハルキ) against EXP-01 to EXP-06 of the travel and expense policy: 4 NG (lines 2, 5, 6 and 7), 2 caution (lines 3 and 4) and 1 OK (line 1). The approved report is saved to expense-reports/${CLAIM}_review.md.\n\n${TABLE.en}\n\nThe approver decides what is paid.`,
};

export const expense: Recorder = (ask) => {
  carries(ask, `expense/inbox/${CLAIM}.csv`);
  return playUseCase(
    ask.slug,
    expenseAgent,
    reporting({
      queries: [],
      open: [`expense/inbox/${CLAIM}.csv`, ...STANDARDS],
      file: `expense-reports/${CLAIM}_review.md`,
      report: `# ${CLAIM} ${ask.lang === 'ja' ? 'チェック' : 'check'}\n\n${TABLE[ask.lang]}\n`,
      answer: ANSWER[ask.lang],
    }),
    ask,
  );
};
