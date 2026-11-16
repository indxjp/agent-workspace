import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'territory',
  area: 'sales',
  status: 'soon',
  wave: 3,
  name: {
    ja: '営業エリア計画',
    en: 'Territory planner',
  },
  summary: {
    ja: '顧客リストと実績から、担当エリアの配分案を作る。',
    en: 'Proposes territory assignments from customers and results.',
  },
});
