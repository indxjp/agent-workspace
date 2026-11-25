import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'price-guard',
  area: 'sales',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/price-guard',
  name: {
    ja: '価格・条件チェック',
    en: 'Pricing guardrail',
  },
  summary: {
    ja: '見積の値引き率や支払条件が社内ルールの範囲内かを確認する。',
    en: 'Checks discounts and payment terms against company rules.',
  },
  demo: {
    agent: 'price-guard',
    prompts: [
      {
        ja: 'price-guard/inbox/見積_Q-2611-031_シギ電設.md を価格ルールに照らしてチェックして',
        en: 'Check price-guard/inbox/見積_Q-2611-031_シギ電設.md against the pricing rules',
      },
      {
        ja: 'price-guard/inbox/見積_Q-2611-031_シギ電設.md の提示単価が価格表の下限単価を下回っていないか、PG-02 だけ確かめて',
        en: 'Check only PG-02: are the offered unit prices in price-guard/inbox/見積_Q-2611-031_シギ電設.md at or above the floor prices?',
      },
    ],
    moment: {
      ja: '見積を渡すと、値引率・下限単価・支払条件などがルールごとに「OK・要注意・NG」で並び、チェック結果の保存は承認を待つ。',
      en: 'Hand over a quote; discounts, floor prices and terms are each marked OK, caution or NG by rule, and saving waits for approval.',
    },
    data: {
      ja: '架空の見積・価格表・価格と取引条件のルール',
      en: 'fictional quotes, a price list and pricing rules',
    },
    seed: [{ collection: 'price-guard', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
