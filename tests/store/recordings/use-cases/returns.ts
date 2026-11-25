/**
 * The returns entry's recorder: the return request the prompt names read, its order's rows found by
 * searching the order number and read, the five policy items read, and one verdict per item
 * (RET-01 to RET-05) written as the review behind the approval. The facts are quoted as the request
 * and the order export give them; the deadline is the export's, never computed. The demo seeds the
 * Japanese data only, so the English review quotes the Japanese files.
 */
import returnsAgent from '../../../../use-cases/returns/agents/returns.ts';
import type { Lang, Recorder } from '../types.ts';
import { playUseCase } from '../use-case-desk.ts';
import { carries, reporting, table, type Bilingual } from '../use-case-script.ts';

const REQUEST = 'R-1102_返品申込';
const ORDER = 'H-20261103-0071';
const STANDARDS = [
  'RET-01-deadline',
  'RET-02-condition',
  'RET-03-excluded',
  'RET-04-order-match',
  'RET-05-shipping',
].map((name) => `returns/standards/${name}.md`);

const ROWS: Readonly<Record<Lang, readonly (readonly string[])[]>> = {
  ja: [
    [
      '返品の期限',
      '申込日「2026-11-18」、返品受付期限「2026-11-20」',
      'OK',
      '申込日が返品受付期限の日付以前〔RET-01〕',
      '',
    ],
    [
      '商品の状態',
      '商品の状態「未使用・箱あり」',
      'OK',
      '未使用で、付属品の箱がある〔RET-02〕',
      '',
    ],
    [
      '返品できない商品',
      '返品可否「不可（名入れ品）」、理由「色がイメージと違った」',
      'NG',
      '名入れ品で、理由はお客様のご都合〔RET-03〕',
      '初期不良・破損・誤配送の申し出ではないことを、お客様に確かめる',
    ],
    [
      '注文との照合',
      `注文番号「${ORDER}」の行「名入れマグカップ」の数量は「1」、申込書の数量は「2」`,
      '要確認',
      '注文番号の行と商品名は一致するが、数量が一致しない〔RET-04〕',
      '返品したい数量をお客様に確かめる',
    ],
    [
      '返送料の負担',
      '理由「色がイメージと違った」',
      'OK',
      '理由がお客様のご都合のため、返送料はお客様の負担〔RET-05〕',
      '',
    ],
  ],
  en: [
    [
      'Return deadline',
      'Request date 「2026-11-18」, return deadline 「2026-11-20」',
      'OK',
      'The request date is on or before the return deadline [RET-01]',
      '',
    ],
    [
      'Condition of the item',
      'Condition 「未使用・箱あり」 (unused, with its box)',
      'OK',
      'Unused, with its box [RET-02]',
      '',
    ],
    [
      'Items that cannot be returned',
      'Returnable 「不可（名入れ品）」 (no, personalised item), reason 「色がイメージと違った」 (the colour was not as expected)',
      'NG',
      "A personalised item, returned for the customer's own reasons [RET-03]",
      'Confirm with the customer that this is not a defect, damage or wrong delivery',
    ],
    [
      'Match with the order',
      `Order 「${ORDER}」, row 「名入れマグカップ」 (personalised mug): quantity 「1」; the request says 「2」`,
      'caution',
      'The order row and the item match, but the quantity does not [RET-04]',
      'Ask the customer how many they want to return',
    ],
    [
      'Return shipping',
      'Reason 「色がイメージと違った」 (the colour was not as expected)',
      'OK',
      "The customer's own reasons, so the customer pays the return shipping [RET-05]",
      '',
    ],
  ],
};

const HEADER: Readonly<Record<Lang, readonly string[]>> = {
  ja: ['項目', '申込と注文', '判定', '理由', '確認したいこと'],
  en: ['Item', 'Request and order', 'Verdict', 'Why', 'To confirm'],
};

const LEAD: Bilingual = {
  ja: `返品申込 ${REQUEST} を、注文データ（注文番号 ${ORDER}）と返品規程の5項目に照らして確認しました。NGが1件（RET-03 返品できない商品）、要確認が1件（RET-04 注文との照合）、OKが3件です。`,
  en: `I checked return request ${REQUEST} against the order record (order ${ORDER}) and the five items of the return policy: 1 NG (RET-03, items that cannot be returned), 1 caution (RET-04, match with the order) and 3 OK.`,
};

const CLOSE: Bilingual = {
  ja: '返品・返金を受け付けるかどうかは担当者が判断してください。',
  en: 'A person decides whether to accept the return and refund.',
};

export const returns: Recorder = (ask) => {
  carries(ask, `returns/inbox/${REQUEST}.md`);
  const lang = ask.lang;
  const file = `returns-reports/${REQUEST}_review.md`;
  const review = table(HEADER[lang], ROWS[lang]);
  const saved =
    lang === 'ja'
      ? `承認された確認表を ${file} に保存しました。`
      : `The approved review is saved to ${file}.`;
  return playUseCase(
    ask.slug,
    returnsAgent,
    reporting({
      open: [`returns/inbox/${REQUEST}.md`, ...STANDARDS],
      queries: [ORDER],
      needs: ['returns/orders/orders.csv'],
      file,
      report: `# ${REQUEST} ${lang === 'ja' ? '確認表' : 'review'}\n\n${review}\n`,
      answer: `${LEAD[lang]}\n\n${review}\n\n${saved}\n\n${CLOSE[lang]}`,
    }),
    ask,
  );
};
