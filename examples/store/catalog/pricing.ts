import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'pricing',
  area: 'analytics',
  status: 'soon',
  wave: 3,
  name: {
    ja: '価格分析',
    en: 'Pricing analyst',
  },
  summary: {
    ja: '値上げや値下げの影響を過去のデータから試算する。',
    en: 'Estimates the effect of price changes from history.',
  },
});
