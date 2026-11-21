import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'returns',
  area: 'support',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/returns',
  name: {
    ja: '返品・交換受付',
    en: 'Returns desk',
  },
  summary: {
    ja: '返品の申込を返品規程と注文データに照らし、項目ごとに判定する（返金は人が判断）。',
    en: 'Checks a return request against the return policy and the order record (a person decides the refund).',
  },
  demo: {
    agent: 'returns',
    prompts: [
      {
        ja: 'returns/inbox/R-1102_返品申込.md を返品規程に照らして確認して',
        en: 'Check returns/inbox/R-1102_返品申込.md against the return policy',
      },
      {
        ja: 'RET-03 の返品できない商品の基準を説明して',
        en: 'Explain the RET-03 rule on items that cannot be returned.',
      },
    ],
    moment: {
      ja: '返品の申込を渡すと、規程の項目ごとに判定と確認点が並び、確認表の保存は承認を待つ。',
      en: 'Hand over a return request; each policy item gets a verdict and what to confirm, and the review waits for approval.',
    },
    data: {
      ja: '架空の返品申込2通・注文データ・返品規程',
      en: '2 fictional return requests, order records, the return policy',
    },
    seed: [{ collection: 'returns', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
