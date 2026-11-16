import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'returns',
  area: 'support',
  status: 'soon',
  wave: 2,
  name: {
    ja: '返品・交換受付',
    en: 'Returns desk',
  },
  summary: {
    ja: '注文番号から返品できるかを判定し、手続きを案内する。',
    en: 'Checks whether an order can be returned and walks the customer through it.',
  },
});
