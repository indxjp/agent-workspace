import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'spare-parts',
  area: 'mfg',
  status: 'soon',
  wave: 2,
  name: {
    ja: '保守部品の手配',
    en: 'Spare parts planner',
  },
  summary: {
    ja: '故障の傾向と在庫から、発注すべき保守部品を提案する。',
    en: 'Suggests spare parts to order from failure trends and stock.',
  },
});
