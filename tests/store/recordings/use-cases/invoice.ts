/**
 * The invoice entry's recorder: the invoice the prompt names, then a search for its order number,
 * which finds the purchase order and the delivery note in `invoice/purchase-records/`, both read,
 * and the four matching rules read. One verdict per invoice line, and the result written behind the
 * approval. No amount is recomputed: the table quotes the documents' own quantities and prices.
 */
import invoiceAgent from '../../../../use-cases/invoice/agents/invoice.ts';
import type { Recorder } from '../types.ts';
import { carries, read, reporting, table, type Bilingual } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const INVOICE = '請求書_ミサゴ工業_INV-M-24117';
const ORDER = 'PO-2611-0315';
const STANDARDS = [
  'MATCH-01-on-order',
  'MATCH-02-unit-price',
  'MATCH-03-quantity',
  'MATCH-04-references',
].map((name) => `invoice/standards/${name}.md`);

const TABLE: Bilingual = {
  ja: table(
    ['明細', '品番', '請求', '発注', '検収', '判定', '理由', '処置', 'ルール'],
    [
      [
        '1',
        'BLT-M8-30',
        '2,000本 × 18',
        '2000本 × 18',
        '2000',
        'OK',
        '品番・単価・数量が発注書と納品書に一致',
        '',
        '〔MATCH-03〕',
      ],
      [
        '2',
        'NUT-M8',
        '2,000個 × 6.5',
        '2000個 × 6',
        '2000',
        'NG',
        '請求単価 6.5 が発注単価 6 と一致しない',
        '発注書の単価での再発行を仕入先に依頼する',
        '〔MATCH-02〕',
      ],
      [
        '3',
        'WSH-M8',
        '2,000枚 × 4',
        '2000枚 × 4',
        '1500',
        'NG',
        '請求数量 2,000 が検収数量 1500 より多い',
        '検収数量での再発行を仕入先に依頼する',
        '〔MATCH-03〕',
      ],
      [
        '4',
        'SPR-110',
        '500個 × 42',
        '500個 × 42',
        '500',
        '要注意',
        '納品書番号の記載がない（品番・単価・数量は一致）',
        '欠けている番号を仕入先に確認し、照合の記録に書き足す',
        '〔MATCH-04〕',
      ],
      [
        '5',
        'FRT（送料）',
        '1式 × 1,500',
        'なし',
        'なし',
        'NG',
        '発注書にない品番（送料）',
        '削除した請求書の再発行を仕入先に依頼するか、購買担当が追加の発注を確認する',
        '〔MATCH-01〕',
      ],
    ],
  ),
  en: table(
    ['Line', 'Part', 'Invoice', 'Order', 'Accepted', 'Verdict', 'Why', 'Action', 'Rule'],
    [
      [
        '1',
        'BLT-M8-30',
        '2,000 × 18',
        '2000 × 18',
        '2000',
        'OK',
        'Part, unit price and quantity match the order and the delivery note',
        '',
        '[MATCH-03]',
      ],
      [
        '2',
        'NUT-M8',
        '2,000 × 6.5',
        '2000 × 6',
        '2000',
        'NG',
        'The unit price 6.5 does not match the order price 6',
        'Ask the supplier to reissue at the order price',
        '[MATCH-02]',
      ],
      [
        '3',
        'WSH-M8',
        '2,000 × 4',
        '2000 × 4',
        '1500',
        'NG',
        'The invoiced quantity 2,000 is more than the 1500 accepted',
        'Ask the supplier to reissue for the accepted quantity',
        '[MATCH-03]',
      ],
      [
        '4',
        'SPR-110',
        '500 × 42',
        '500 × 42',
        '500',
        'caution',
        'No delivery note number (part, price and quantity match)',
        'Confirm the missing number with the supplier and add it to the record',
        '[MATCH-04]',
      ],
      [
        '5',
        'FRT (shipping)',
        '1 × 1,500',
        'none',
        'none',
        'NG',
        'A part that is not on the order (shipping)',
        'Ask the supplier to reissue without it, or purchasing confirms an extra order',
        '[MATCH-01]',
      ],
    ],
  ),
};

const ANSWER: Bilingual = {
  ja: `請求書 INV-M-24117（株式会社ミサゴ工業）を、発注書 ${ORDER} と納品書 DN-58821 と照合しました。NGが3件（明細2・3・5）、要注意が1件（明細4）、OKが1件（明細1）です。承認された照合結果を invoice-reports/${INVOICE}_review.md に保存しました。小計・消費税・合計は判定していません。担当者又は会計システムで確認してください。\n\n${TABLE.ja}\n\n支払うかどうかは担当者が判断してください。`,
  en: `I matched invoice INV-M-24117 (株式会社ミサゴ工業) with order ${ORDER} and delivery note DN-58821: 3 NG (lines 2, 3 and 5), 1 caution (line 4) and 1 OK (line 1). The approved result is saved to invoice-reports/${INVOICE}_review.md. The subtotal, the tax and the total are not judged: a person or the accounting system checks them.\n\n${TABLE.en}\n\nA person decides whether to pay.`,
};

export const invoice: Recorder = (ask) => {
  carries(ask, `invoice/inbox/${INVOICE}.md`);
  return playUseCase(
    ask.slug,
    invoiceAgent,
    reporting({
      queries: [ORDER],
      open: [`invoice/inbox/${INVOICE}.md`],
      needs: [
        `invoice/purchase-records/発注書_${ORDER}.csv`,
        'invoice/purchase-records/納品書_DN-58821.csv',
      ],
      before: (context) => read(context, STANDARDS),
      file: `invoice-reports/${INVOICE}_review.md`,
      report: `# ${INVOICE} ${ask.lang === 'ja' ? '照合結果' : 'match'}\n\n${TABLE[ask.lang]}\n`,
      answer: ANSWER[ask.lang],
    }),
    ask,
  );
};
