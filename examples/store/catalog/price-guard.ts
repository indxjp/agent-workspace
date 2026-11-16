import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'price-guard',
  area: 'sales',
  status: 'soon',
  wave: 3,
  name: {
    ja: '価格・条件チェック',
    en: 'Pricing guardrail',
  },
  summary: {
    ja: '見積の値引き率や支払条件が社内ルールの範囲内かを確認する。',
    en: 'Checks discounts and payment terms against company rules.',
  },
});
