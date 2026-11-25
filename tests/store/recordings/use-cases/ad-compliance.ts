/**
 * The ad-compliance entry's recorder: the product-page draft the prompt names, read with the six
 * items of the advertising standard (as of 2026-10-01), one verdict per claim in the draft's order,
 * and the report written behind the approval.
 */
import adComplianceAgent from '../../../../use-cases/ad-compliance/agents/ad-compliance.ts';
import type { Recorder } from '../types.ts';
import { carries, reporting, table, type Bilingual } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const COPY = 'LP原稿_加湿空気清浄機KAZE-9';
const STANDARDS = [
  'AD-01-superlatives',
  'AD-02-performance',
  'AD-03-pricing',
  'AD-04-free-and-limited',
  'AD-05-disclaimers',
  'AD-06-testimonials',
].map((name) => `ad-compliance/standards/${name}.md`);

const CLAIM = {
  no1: '業界No.1の除菌力。',
  pollen:
    '花粉を99.9%除去（※当社試験室（約8畳）で60分運転したときの試験結果。実際の使用空間での効果ではありません）',
  colds: 'これ一台で、家族みんなが風邪をひかない体に。',
  filter: 'フィルター交換不要。',
  shipping: '送料無料（沖縄・離島への配送を除く）',
  price: '通常価格 49,800円 → 今だけ 29,800円（税込）',
  today: '本日限定！ この価格は今日だけです。',
  voice: '「使い始めてから、家族全員が健康になりました。」（40代・主婦）※個人の感想です',
};

const TABLE: Bilingual = {
  ja: table(
    ['表現', '判定', '理由', '修正案', '基準'],
    [
      [
        CLAIM.no1,
        'NG',
        '調査の主体・期間・対象が同じ画面に示されていない',
        '根拠を示せない場合は表示を削る。示せる場合は調査機関名、調査期間、対象を同じ画面に添える',
        '〔AD-01〕',
      ],
      [CLAIM.pollen, 'OK', '試験の条件がすぐ近くに示されている', '', '〔AD-02〕'],
      [CLAIM.colds, 'NG', '家電で病気の予防をうたっている', '健康効果の表示を削る', '〔AD-02〕'],
      [
        CLAIM.filter,
        '要注意',
        '条件（1日8時間使用した場合の目安）がページの末尾にだけある',
        '「※1日8時間使用した場合の目安です」を表示の直後に移す',
        '〔AD-05〕',
      ],
      [CLAIM.shipping, 'OK', '条件がすぐ近くに示されている', '', '〔AD-04〕'],
      [
        CLAIM.price,
        '要注意',
        '通常価格で販売した期間と実績の記載がない。販売実績の確認を担当部署に依頼する',
        '「通常価格（〇年〇月〇日〜〇月〇日の当社販売価格）」のように期間を示す。実績を示せない場合は比較対照価格を削る',
        '〔AD-03〕',
      ],
      [
        CLAIM.today,
        'NG',
        'キャンペーン期間（2026年12月1日〜12月31日）と一致しない',
        '「キャンペーン期間：2026年12月1日〜12月31日」と実際の期間を示す',
        '〔AD-04〕',
      ],
      [
        CLAIM.voice,
        'NG',
        '体験談で健康の効果を示している（AD-02 の健康効果にも当たる）。「個人の感想です」を添えても NG',
        '使い心地の感想に差し替える',
        '〔AD-06〕',
      ],
    ],
  ),
  en: table(
    ['Claim', 'Verdict', 'Why', 'Suggested fix', 'Item'],
    [
      [
        CLAIM.no1,
        'NG',
        'The No. 1 claim shows no survey body, period or scope on the same screen',
        'Remove it, or add the survey body, period and scope on the same screen',
        '[AD-01]',
      ],
      [CLAIM.pollen, 'OK', 'The test conditions are right next to the figure', '', '[AD-02]'],
      [
        CLAIM.colds,
        'NG',
        'An appliance claims to keep the family from catching colds',
        'Remove the health claim',
        '[AD-02]',
      ],
      [
        CLAIM.filter,
        'caution',
        'Its condition (a guide for 8 hours of use a day) is only at the foot of the page',
        'Move the condition right after the claim',
        '[AD-05]',
      ],
      [CLAIM.shipping, 'OK', 'The condition is right next to the claim', '', '[AD-04]'],
      [
        CLAIM.price,
        'caution',
        'The regular price gives no sales period or record; ask the department to confirm the sales record',
        'State the period the regular price was charged, or remove the reference price',
        '[AD-03]',
      ],
      [
        CLAIM.today,
        'NG',
        '"Today only" does not match the campaign period of December 1 to December 31, 2026',
        'State the real period: "Campaign period: December 1 to December 31, 2026"',
        '[AD-04]',
      ],
      [
        CLAIM.voice,
        'NG',
        'A testimonial claims a health effect (also AD-02); "individual opinion" does not change that',
        'Replace it with a comment on how the product feels to use',
        '[AD-06]',
      ],
    ],
  ),
};

const ANSWER: Bilingual = {
  ja: `${COPY}.md を、広告表示基準（2026-10-01 時点）の AD-01〜AD-06 と照らしました。NGが4件、要注意が2件、OKが2件です。承認されたレポートを ad-compliance-reports/${COPY}_review.md に保存しました。\n\n${TABLE.ja}\n\n掲載するかどうかは担当者が判断してください。`,
  en: `I checked ${COPY}.md against AD-01 to AD-06 of the advertising standard (as of 2026-10-01): 4 NG, 2 caution and 2 OK. The approved report is saved to ad-compliance-reports/${COPY}_review.md.\n\n${TABLE.en}\n\nA person decides whether to publish.`,
};

export const adCompliance: Recorder = (ask) => {
  carries(ask, `ad-compliance/inbox/${COPY}.md`);
  return playUseCase(
    ask.slug,
    adComplianceAgent,
    reporting({
      queries: [],
      open: [`ad-compliance/inbox/${COPY}.md`, ...STANDARDS],
      file: `ad-compliance-reports/${COPY}_review.md`,
      report: `# ${COPY} ${ask.lang === 'ja' ? 'レビュー' : 'review'}\n\n${TABLE[ask.lang]}\n`,
      answer: ANSWER[ask.lang],
    }),
    ask,
  );
};
